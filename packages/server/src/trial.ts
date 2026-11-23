// Trials: try things on the device several ways, several times, and compare them on the laptop. A trial is
// data: variants (what to try: scripts, HTML, code, values), remote keys to press, checks read once,
// the runs, and the files the laptop serves to the device for it. Every run is profiled without being
// asked (profile.ts says what each number means): load, frames, main-thread blocking, key → frame,
// heap, DOM, layout, images, requests and media. A measure is optional and adds its own numbers. Each
// run gets a fresh blank frame over the page, so a polyfill or a player loaded for one variant never
// reaches the app or the next run, and the code sees the engine's own globals. Runs alternate (A B,
// B A, ...) so a drift in the page doesn't read as a difference. The runner starts a run and returns
// at once; the laptop polls for the result, so a long run never holds the inspector's queue.
import { randomBytes } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { basename, extname, isAbsolute, join, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { bootstrapDiffCI, median, summarize as summary, type Summary } from '@teleport/stats';
import { typeOf } from './app.js';
import { betterOf, profileNotes } from './profile.js';
import { KEY, KEYS, pressFor, type KeyId, type Press } from './remote.js';
import { describeUa } from './ua.js';

export type Value = number | string | boolean | null;
export type Metrics = Record<string, Value>;

export interface Variant {
  name: string;
  /** ES5 run in the frame before its scripts load, such as removing a native global a polyfill would otherwise leave alone. */
  before: string;
  /** Loaded in order before `setup`: asset names, paths on the app's server, or http(s) URLs. */
  scripts: string[];
  /** Written into the frame's body first. */
  html: string;
  /** ES5 run in the frame after the scripts, before the measure. */
  setup: string;
  /** What the measure reads as T.vars. */
  vars: Record<string, unknown>;
}

export interface TrialSpec {
  name: string;
  /** A fresh blank frame over the page for every run, or the page itself. */
  where: 'frame' | 'page';
  variants: Variant[];
  /** ES5 function body called with T, or '' for none; it ends with T.done({metric: value}) or T.fail(why). */
  measure: string;
  /** How long each run is watched after setup, while keys are pressed and the profile runs. */
  observeMs: number;
  /** Remote keys pressed in turn during the window, keyGapMs apart. */
  keys: KeyId[];
  keyGapMs: number;
  /** Measure the profile in every run. */
  profile: boolean;
  /** ES5 expressions read once on the device, in a blank frame, before the runs: the facts that say why. A Promise is waited for. */
  checks: Record<string, string>;
  /** Runs of each variant. */
  runs: number;
  timeoutMs: number;
  /** Files, folders and URLs the laptop serves to the device for this trial, by name: an absolute path or an http(s) URL. A trailing slash serves the folder or the URL prefix. */
  assets: Record<string, string>;
  /** Which way is better, for metrics where it's known. */
  better: Record<string, 'lower' | 'higher'>;
}

export interface Sample {
  variant: string;
  round: number;
  ok: boolean;
  metrics: Metrics;
  error: string | null;
  /** Errors the frame threw outside the measure's own code. */
  uncaught: string[];
  ms: number | null;
}

export interface VariantResult {
  name: string;
  runs: number;
  ok: number;
  errors: { message: string; count: number }[];
  numbers: Record<string, Summary>;
  values: Record<string, { value: Value; count: number }[]>;
}

export interface Comparison {
  metric: string;
  variant: string;
  baseline: string;
  /** Median of the variant minus median of the baseline, with its bootstrap 95% CI. */
  diff: number;
  lo: number;
  hi: number;
  /** Null when the interval spans zero or which way is better isn't known. */
  better: 'yes' | 'no' | null;
  text: string;
}

export interface TrialReport {
  name: string;
  device: { id: string; ua: string; engine: string };
  startedAt: number;
  ms: number;
  /** Stopped before every run, to answer within the time a caller waits. */
  truncated: boolean;
  notes: string[];
  variants: VariantResult[];
  compare: Comparison[];
  checks: Metrics | null;
  checksError: string | null;
  samples: Sample[];
}

export const TRIAL_BASE = '/__teleport/trial/';
const MAX_VARIANTS = 8;
const MAX_RUNS = 30;
const DEFAULT_RUNS = 5;
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 60_000;
const MAX_CODE = 100_000;
const MAX_CHECKS = 64;
const MAX_METRICS = 64;
const MAX_STR = 200;
/** A check's or a metric's name: long enough for an expression used as its own name. */
const MAX_NAME = 300;
const DEFAULT_OBSERVE_MS = 2000;
const MAX_OBSERVE_MS = 30_000;
const DEFAULT_KEY_GAP_MS = 400;
const MAX_KEYS = 100;
const SPEC_FIELDS = ['name', 'where', 'variants', 'html', 'scripts', 'before', 'setup', 'measure', 'keys', 'keyGapMs', 'observeMs', 'checks', 'runs', 'timeoutMs', 'assets', 'better', 'profile'];
const VARIANT_FIELDS = ['name', 'html', 'scripts', 'before', 'setup', 'vars'];
/** A caller's HTTP client gives up at 300 s; the report must be back before. */
const BUDGET_MS = 270_000;
/** How often the laptop asks the device for a run's result when the device can't tell it (no inspector hook). */
const POLL_MS = 150;
/** With the hook, the device says when a run is done; the laptop still asks this often in case that word was lost. */
const FALLBACK_POLL_MS = 2000;
const GRACE_MS = 5_000;
const MIN_COMPARE = 3;
const SEED = 1;

// ---- The spec, at the boundary --------------------------------------------------------------------

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isUrl = (s: string) => /^https?:\/\//i.test(s);
const clamp = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(Math.max(Math.round(v), lo), hi) : d);

function code(v: unknown, what: string): string {
  if (v === undefined || v === null || v === '') return '';
  if (typeof v !== 'string') throw new Error(`${what} must be ES5 source as a string`);
  if (v.length > MAX_CODE) throw new Error(`${what} is over ${MAX_CODE} characters`);
  // A whole function, as `String(fn)` gives it, is called with T.
  return /^\s*(async\s+)?(function\b|\(?[\w$,\s]*\)?\s*=>)/.test(v) ? `return (${v.trim()})(T);` : v;
}

function text(v: unknown, what: string, max = MAX_CODE): string {
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string') throw new Error(`${what} must be a string`);
  if (v.length > max) throw new Error(`${what} is over ${max} characters`);
  return v;
}

/** The spec from outside (an agent, a file, the API), checked; throws saying what is wrong. */
export function parseSpec(raw: unknown): TrialSpec {
  if (!isObj(raw)) throw new Error('a trial is an object with variants');
  const assets: Record<string, string> = {};
  if (raw.assets !== undefined) {
    if (!isObj(raw.assets)) throw new Error('assets maps names to paths or URLs');
    for (const [k, v] of Object.entries(raw.assets)) {
      if (!/^[\w-]{1,40}$/.test(k)) throw new Error(`asset name ${k}: letters, digits, - and _ only`);
      if (typeof v !== 'string' || !(isAbsolute(v) || isUrl(v))) throw new Error(`asset ${k}: an absolute path or an http(s) URL`);
      assets[k] = v;
    }
  }
  const unknown = Object.keys(raw).find((k) => !SPEC_FIELDS.includes(k));
  if (unknown) throw new Error(`a trial has no field ${unknown}; a trial has ${SPEC_FIELDS.join(', ')}`);
  if (!Array.isArray(raw.variants) || raw.variants.length < 1 || raw.variants.length > MAX_VARIANTS) throw new Error(`a trial has 1 to ${MAX_VARIANTS} variants`);
  const scriptsOf = (v: unknown, who: string): string[] => {
    const list = v === undefined ? [] : v;
    if (!Array.isArray(list) || list.some((s) => typeof s !== 'string')) throw new Error(`${who}: scripts is a list of strings`);
    for (const s of list as string[]) if (!(s in assets) && !isUrl(s) && !s.startsWith('/')) throw new Error(`${who}: script ${s} is neither an asset nor a URL`);
    return list as string[];
  };
  // What every variant shares comes first, then the variant's own.
  const shared = { before: code(raw.before, 'before'), scripts: scriptsOf(raw.scripts, 'the trial'), html: text(raw.html, 'html'), setup: code(raw.setup, 'setup') };
  const join = (a: string, b: string) => (a && b ? `${a}\n;${b}` : a || b);
  const names = new Set<string>();
  const variants = raw.variants.map((v, i): Variant => {
    if (!isObj(v)) throw new Error(`variant ${i + 1} is not an object`);
    const name = typeof v.name === 'string' && v.name.trim() ? v.name.trim().slice(0, 60) : `v${i + 1}`;
    if (names.has(name)) throw new Error(`two variants named ${name}`);
    names.add(name);
    const extra = Object.keys(v).find((k) => !VARIANT_FIELDS.includes(k));
    if (extra) throw new Error(`variant ${name} has no field ${extra}; a variant has ${VARIANT_FIELDS.join(', ')}`);
    if (v.vars !== undefined && !isObj(v.vars)) throw new Error(`variant ${name}: vars is an object`);
    const vars = (v.vars ?? {}) as Record<string, unknown>;
    if (JSON.stringify(vars).length > MAX_CODE) throw new Error(`variant ${name}: vars are over ${MAX_CODE} characters`);
    return {
      name,
      before: join(shared.before, code(v.before, `${name}'s before`)),
      scripts: [...shared.scripts, ...scriptsOf(v.scripts, `variant ${name}`)],
      html: shared.html + text(v.html, `${name}'s html`),
      setup: join(shared.setup, code(v.setup, `${name}'s setup`)),
      vars,
    };
  });
  const measure = code(raw.measure, 'the measure');
  const keys = raw.keys === undefined ? [] : raw.keys;
  if (!Array.isArray(keys) || keys.length > MAX_KEYS || keys.some((k) => typeof k !== 'string' || !Object.prototype.hasOwnProperty.call(KEY, k)))
    throw new Error(`keys are remote key names: ${KEYS.map((k) => k.id).join(', ')} (at most ${MAX_KEYS})`);
  const keyGapMs = clamp(raw.keyGapMs, 50, 5000, DEFAULT_KEY_GAP_MS);
  // The window covers every press and the frame after the last.
  const observeMs = Math.max(clamp(raw.observeMs, 0, MAX_OBSERVE_MS, measure ? 0 : DEFAULT_OBSERVE_MS), keys.length ? keys.length * keyGapMs + 600 : 0);
  const timeoutMs = Math.max(clamp(raw.timeoutMs, 1000, MAX_TIMEOUT_MS, DEFAULT_TIMEOUT_MS), Math.min(MAX_TIMEOUT_MS, observeMs + 2000));
  const where = raw.where === undefined ? 'frame' : raw.where;
  if (where !== 'frame' && where !== 'page') throw new Error('where is frame or page');
  const checks: Record<string, string> = {};
  if (raw.checks !== undefined) {
    if (!isObj(raw.checks)) throw new Error('checks maps names to ES5 expressions');
    const entries = Object.entries(raw.checks);
    if (entries.length > MAX_CHECKS) throw new Error(`at most ${MAX_CHECKS} checks`);
    for (const [k, v] of entries) checks[k.slice(0, MAX_NAME)] = text(v, `check ${k}`, 4000);
  }
  const better: Record<string, 'lower' | 'higher'> = {};
  if (isObj(raw.better)) for (const [k, v] of Object.entries(raw.better)) if (v === 'lower' || v === 'higher') better[k] = v;
  return {
    name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 120) : 'trial',
    where,
    variants,
    measure,
    observeMs,
    keys: keys as KeyId[],
    keyGapMs,
    profile: raw.profile !== false,
    checks,
    runs: clamp(raw.runs, 1, MAX_RUNS, DEFAULT_RUNS),
    timeoutMs,
    assets,
    better,
  };
}

/** Which variant runs when: forward in even rounds, backward in odd ones. */
export function order(variants: number, runs: number): { variant: number; round: number }[] {
  const out: { variant: number; round: number }[] = [];
  for (let round = 0; round < runs; round++)
    for (let i = 0; i < variants; i++) out.push({ variant: round % 2 ? variants - 1 - i : i, round });
  return out;
}

// ---- On the device -------------------------------------------------------------------------------------

/** JSON is valid JavaScript only once U+2028 and U+2029 are escaped; older engines reject them raw. */
const js = (v: unknown) => JSON.stringify(v).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

// ES5. C is the run, as data. It answers '' at once; the run reports into window.__teleportTrials.
// Teleport's own files resolve against the address the inspector came from, which is teleport as the
// Device reaches it (a tunnel, the LAN, or the app's dev server relaying it). A run ends once its measure
// is done (or it has none) and its window is over; the profile is read then, before cleanup.
const RUNNER = `function(C){
var W=window,R=W.__teleportTrials||(W.__teleportTrials={}),P=W.performance;
var st={done:false,metrics:null,error:null,errors:[],log:[],ms:null};R[C.id]=st;
function now(){return P&&P.now?P.now():new Date().getTime()}
function heap(){return P&&P.memory?P.memory.usedJSHeapSize:null}
function r2(x){return Math.round(x*100)/100}
function asc(a,b){return a-b}
function at(a,q){return a.length?r2(a[Math.min(a.length-1,Math.floor(a.length*q))]):null}
var t0=now(),h0=heap(),f=null,w=W,cleanups=[],extra={},timer=0,onErr=null,base='',ss=document.getElementsByTagName('script'),i,m;
var pr={on:false,fr:[],lag:[],lt:0,ltn:0,obs:null,lts:false,self:0,kh:[],kf:[],tw:0,sm:null},measured=!C.measure,watched=false;
base=(W.__teleportInspector&&W.__teleportInspector.server)||'';
for(i=0;!base&&i<ss.length;i++){m=/^(https?:\\/\\/[^\\/]+)\\/__teleport\\/inspector\\.js/.exec(ss[i].src||'');if(m)base=m[1]}
if(!base)base=location.protocol+'//'+location.host;
function url(u){if(u.indexOf('/__teleport/')===0)return base+u;var a=document.createElement('a');a.href=u;return a.href}
function msg(e){return e&&e.name&&e.message?e.name+': '+e.message:String(e)}
function raf(cb){var r=w.requestAnimationFrame||w.webkitRequestAnimationFrame;if(r)r.call(w,cb);else setTimeout(cb,16)}
function profile(){pr.on=true;pr.tw=now();var last=-1,due=now()+50;
function tick(){if(!pr.on)return;var a=now();if(last>=0&&pr.fr.length<5000)pr.fr.push(a-last);last=a;pr.self+=now()-a;raf(tick)}
function lag(){if(!pr.on)return;var a=now();if(pr.lag.length<5000)pr.lag.push(a>due?a-due:0);due=a+50;pr.self+=now()-a;setTimeout(lag,50)}
raf(tick);setTimeout(lag,50);
try{var PO=W.PerformanceObserver;if(PO&&PO.supportedEntryTypes&&PO.supportedEntryTypes.indexOf('longtask')>=0){
pr.obs=new PO(function(l){var e=l.getEntries();for(var j=0;j<e.length;j++){pr.lt+=e[j].duration;pr.ltn++}});pr.obs.observe({entryTypes:['longtask']});pr.lts=true}}catch(e){}}
function ev(type,k){var d=w.document,e;try{e=new w.KeyboardEvent(type,{key:k.key,code:k.code,bubbles:true,cancelable:true})}
catch(y){e=d.createEvent('KeyboardEvent');if(e.initKeyboardEvent)e.initKeyboardEvent(type,true,true,w,k.key,0,'',false,'');else e.initEvent(type,true,true)}
var ps={key:k.key,code:k.code,keyCode:k.keyCode,which:k.keyCode};
for(var p in ps)if(e[p]!==ps[p]){try{Object.defineProperty(e,p,{get:(function(v){return function(){return v}})(ps[p])})}catch(y){}}return e}
function press(k){var d=w.document,t=d.activeElement||d.body,a=now();t.dispatchEvent(ev('keydown',k));t.dispatchEvent(ev('keyup',k));pr.kh.push(now()-a);
raf(function(){raf(function(){pr.kf.push(now()-a)})})}
function collect(){var x={},d=w.document,j,a,n,s,slow=0;
x.loadMs=r2((pr.tw||now())-t0);if(pr.sm!==null)x.scriptsMs=pr.sm;
if(pr.tw){a=pr.fr.slice().sort(asc);n=a.length;s=0;for(j=0;j<n;j++){s+=a[j];if(a[j]>50)slow++}
x.frames=n;x.fps=s?Math.round(n*10000/s)/10:null;x.frameP95Ms=at(a,0.95);x.frameWorstMs=n?r2(a[n-1]):null;x.slowFrames=n?slow:null;
a=pr.lag.slice().sort(asc);x.lagP95Ms=at(a,0.95);x.lagMaxMs=a.length?r2(a[a.length-1]):null;
x.longTaskMs=pr.lts?r2(pr.lt):null;x.longTasks=pr.lts?pr.ltn:null}
var h=heap();x.heapKB=h===null?null:Math.round(h/1024);x.heapDeltaKB=h===null||h0===null?null:Math.round((h-h0)/1024);
x.domNodes=d.getElementsByTagName('*').length;
if(d.body){var b=d.body,sw=b.style.width;b.style.width='99%';a=now();n=b.offsetHeight;x.layoutMs=r2(now()-a);b.style.width=sw}
var im=d.getElementsByTagName('img'),kb=0,br=0;
if(im.length){for(j=0;j<im.length;j++)if(im[j].complete){if(im[j].naturalWidth)kb+=im[j].naturalWidth*im[j].naturalHeight*4;else br++}
x.images=im.length;x.imageKB=Math.round(kb/1024);x.imagesBroken=br}
var wp=w.performance;if(wp&&wp.getEntriesByType){var rs=wp.getEntriesByType('resource'),c=0,by=0,sized=false,mx=0;
for(j=0;j<rs.length;j++){var e=rs[j];if(w===W&&e.startTime<t0)continue;c++;var z=e.transferSize||e.encodedBodySize;if(z>0){by+=z;sized=true}if(e.responseEnd-e.startTime>mx)mx=e.responseEnd-e.startTime}
x.resources=c;x.resourceKB=sized?Math.round(by/1024):(c?null:0);x.resourceMaxMs=r2(mx)}else{x.resources=null;x.resourceKB=null;x.resourceMaxMs=null}
var vs=d.getElementsByTagName('video'),as=d.getElementsByTagName('audio'),me=0,dc=0,dr=0,mq=false,first=null,CODES={1:'MEDIA_ERR_ABORTED',2:'MEDIA_ERR_NETWORK',3:'MEDIA_ERR_DECODE',4:'MEDIA_ERR_SRC_NOT_SUPPORTED'};
if(vs.length+as.length){var all=[];for(j=0;j<vs.length;j++)all.push(vs[j]);for(j=0;j<as.length;j++)all.push(as[j]);
for(j=0;j<all.length;j++){var v=all[j];if(v.error){me++;if(!first)first=(CODES[v.error.code]||'MEDIA_ERR '+v.error.code)+(v.error.message?': '+v.error.message:'')}}
for(j=0;j<vs.length;j++){var q=vs[j].getVideoPlaybackQuality?vs[j].getVideoPlaybackQuality():null;
if(q){dc+=q.totalVideoFrames;dr+=q.droppedVideoFrames;mq=true}else if(typeof vs[j].webkitDecodedFrameCount==='number'){dc+=vs[j].webkitDecodedFrameCount;dr+=vs[j].webkitDroppedFrameCount||0;mq=true}}
x.media=all.length;if(vs.length){x.mediaDecoded=mq?dc:null;x.mediaDropped=mq?dr:null}x.mediaErrors=me;if(first)x.mediaError=first}
if(C.keys.length){a=pr.kh.slice().sort(asc);x.keyHandlerMs=at(a,0.5);a=pr.kf.slice().sort(asc);x.keyFrameMs=at(a,0.5);x.keyFrameMaxMs=a.length?r2(a[a.length-1]):null}
x.errors=st.errors.length;x.profilerMs=r2(pr.self);
for(var k in x)if(!Object.prototype.hasOwnProperty.call(extra,k))extra[k]=x[k]}
function finish(err){if(st.done)return;st.done=true;clearTimeout(timer);pr.on=false;if(pr.obs){try{pr.obs.disconnect()}catch(e){}}
if(C.profile){try{collect()}catch(e){extra.profileError=msg(e)}}
for(var j=cleanups.length-1;j>=0;j--){try{cleanups[j]()}catch(e){}}
if(onErr&&w.removeEventListener)w.removeEventListener('error',onErr,false);if(f&&f.parentNode)f.parentNode.removeChild(f);f=null;st.ms=now()-t0;st.metrics=extra;st.error=err;
var I=W.__teleportInspector;if(I&&I.notify)I.notify('trial',{id:C.id})}
function complete(){if(measured&&watched)finish(null)}
var T={vars:C.vars,variant:C.variant,round:C.round,now:now,heap:heap,
asset:function(n,p){var a=C.assets[n];return a===undefined?null:url(a+(p||''))},
set:function(k,v){extra[k]=v},
done:function(o){if(o)for(var k in o)if(Object.prototype.hasOwnProperty.call(o,k))extra[k]=o[k];measured=true;complete()},
fail:function(s){finish(String(s))},
cleanup:function(fn){cleanups.push(fn)},
log:function(s){if(st.log.length<50)st.log.push(String(s).slice(0,300))},
frame:function(cb){raf(function(){raf(function(){cb(now())})})},
frames:function(ms,cb){var d=[],last=-1,end=now()+ms;function tick(){var t=now();if(last>=0)d.push(t-last);last=t;if(t<end&&!st.done)return raf(tick);
d.sort(asc);var n=d.length,sum=0,over=0;for(var j=0;j<n;j++){sum+=d[j];if(d[j]>50)over++}
cb({frames:n,fps:sum?Math.round(n*10000/sum)/10:null,p95Ms:at(d,0.95),worstMs:n?r2(d[n-1]):null,over50:over})}raf(tick)},
load:function(u,cb){var s=w.document.createElement('script');s.src=url(u);s.onload=function(){cb(null)};s.onerror=function(){cb('did not load: '+s.src)};(w.document.head||w.document.documentElement).appendChild(s)}};
try{
if(C.where==='frame'){f=document.createElement('iframe');
f.setAttribute('style','position:fixed;left:0;top:0;width:100%;height:100%;border:0;margin:0;padding:0;z-index:2147483647;background:#000');
(document.body||document.documentElement).appendChild(f);w=f.contentWindow;var doc=w.document;doc.open();
doc.write('<!DOCTYPE html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden;background:#000;color:#fff;font:24px sans-serif}</style></head><body>'+C.html+'</body></html>');doc.close()}
else if(C.html){var div=document.createElement('div');div.innerHTML=C.html;document.body.appendChild(div);cleanups.push(function(){if(div.parentNode)div.parentNode.removeChild(div)})}
onErr=function(e){if(st.errors.length<10)st.errors.push(String(e&&e.message||e)+(e&&e.lineno?' (line '+e.lineno+(e.colno?':'+e.colno:'')+')':''))};
if(w.addEventListener)w.addEventListener('error',onErr,false);
timer=setTimeout(function(){finish('timed out after '+C.timeoutMs+' ms'+(st.errors.length?'; uncaught: '+st.errors[0]:''))},C.timeoutMs);
if(C.before)new w.Function('T',C.before)(T)}catch(e){finish('could not start: '+msg(e));return ''}
var k=0,ts=now();
function run(){try{if(C.setup)new w.Function('T',C.setup)(T)}catch(e){return finish('the setup threw: '+msg(e))}if(st.done)return;
if(C.profile)profile();
for(var j=0;j<C.keys.length;j++)(function(key,ms){setTimeout(function(){if(!st.done)press(key)},ms)})(C.keys[j],C.keyGapMs*(j+1));
setTimeout(function(){watched=true;complete()},C.observeMs);
if(C.measure){try{new w.Function('T',C.measure)(T)}catch(e){finish('the measure threw: '+msg(e))}}}
function next(){if(st.done)return;if(k>=C.scripts.length){if(k)pr.sm=r2(now()-ts);return run()}
var s=w.document.createElement('script'),src=url(C.scripts[k++]);s.src=src;s.onload=next;s.onerror=function(){finish('script did not load: '+src)};
(w.document.head||w.document.documentElement).appendChild(s)}
next();return ''}`;

/** ES5 that starts one run of variant `v` and answers '' at once. `paths`: each asset's path under teleport; `presses`: the spec's keys as this device sends them. */
export function startScript(id: string, spec: TrialSpec, v: number, round: number, paths: Record<string, string>, presses: Press[]): string {
  const variant = spec.variants[v]!;
  const C = {
    id,
    where: spec.where,
    html: variant.html,
    before: variant.before,
    scripts: variant.scripts.map((s) => paths[s] ?? s),
    setup: variant.setup,
    measure: spec.measure,
    observeMs: spec.observeMs,
    keys: presses,
    keyGapMs: spec.keyGapMs,
    profile: spec.profile,
    vars: variant.vars,
    timeoutMs: spec.timeoutMs,
    variant: variant.name,
    round,
    assets: paths,
  };
  return `(${RUNNER})(${js(C)})`;
}

/** ES5 that answers a run's state, and forgets a finished run once read. */
export const pollScript = (id: string) =>
  `(function(){var R=window.__teleportTrials,s=R&&R[${js(id)}];if(!s)return {gone:true};if(!s.done)return {done:false};delete R[${js(id)}];return {done:true,metrics:s.metrics,error:s.error,errors:s.errors,log:s.log,ms:s.ms}})()`;

/** The measure that reads the checks: each expression once, in the frame's own globals, a Promise waited for. */
export const checksMeasure = (checks: Record<string, string>) =>
  Object.keys(checks).length
    ? `var C=T.vars.checks,keys=[],k,seen={};for(k in C)if(Object.prototype.hasOwnProperty.call(C,k))keys.push(k);var left=keys.length;
function val(v){if(v===undefined)return null;if(v===null||typeof v==='number'||typeof v==='string'||typeof v==='boolean')return v;try{return JSON.stringify(v)}catch(e){return String(v)}}
function put(k,v){if(seen[k])return;seen[k]=1;T.set(k,val(v));if(--left===0)T.done()}
function one(k){var v;try{v=(new Function('return ('+C[k]+'\\n)'))()}catch(e){return put(k,'threw: '+(e&&e.message||e))}
if(v&&typeof v.then==='function')v.then(function(x){put(k,x)},function(e){put(k,'rejected: '+(e&&(e.message||e.name)||e))});else put(k,v)}
for(var i=0;i<keys.length;i++)one(keys[i]);`
    : 'T.done()';

// ---- On the laptop ---------------------------------------------------------------------------------

function value(v: unknown): Value {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? Math.round(v * 1000) / 1000 : null;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') return v.slice(0, MAX_STR);
  try {
    return (JSON.stringify(v) ?? '').slice(0, MAX_STR);
  } catch {
    return String(v).slice(0, MAX_STR);
  }
}

export function metricsOf(raw: unknown): Metrics {
  const out: Metrics = {};
  if (!isObj(raw)) return out;
  for (const k of Object.keys(raw).slice(0, MAX_METRICS)) out[k.slice(0, MAX_NAME)] = value(raw[k]);
  return out;
}

const r3 = (x: number) => Math.round(x * 1000) / 1000;
const roundSummary = (s: Summary): Summary => ({ n: s.n, median: r3(s.median), p95: r3(s.p95), min: r3(s.min), max: r3(s.max) });
const PARSE_ERROR = /SyntaxError|Unexpected (token|identifier|reserved word|strict mode reserved word)|missing \) after|Use of const in strict mode/;

function variantResult(name: string, samples: Sample[]): VariantResult {
  const errors = new Map<string, number>();
  const nums = new Map<string, number[]>();
  const vals = new Map<string, Map<Value, number>>();
  for (const s of samples) {
    if (s.error) errors.set(s.error, (errors.get(s.error) ?? 0) + 1);
    for (const [k, v] of Object.entries(s.metrics)) {
      if (typeof v === 'number') {
        // As in compare: the medians shown beside a difference are of the runs it was measured on.
        if (!s.ok) continue;
        if (!nums.has(k)) nums.set(k, []);
        nums.get(k)!.push(v);
      } else {
        if (!vals.has(k)) vals.set(k, new Map());
        const m = vals.get(k)!;
        m.set(v, (m.get(v) ?? 0) + 1);
      }
    }
  }
  return {
    name,
    runs: samples.length,
    ok: samples.filter((s) => s.ok).length,
    errors: [...errors].map(([message, count]) => ({ message, count })).sort((a, b) => b.count - a.count),
    numbers: Object.fromEntries([...nums].map(([k, xs]) => [k, roundSummary(summary(xs))])),
    values: Object.fromEntries([...vals].map(([k, m]) => [k, [...m].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count)])),
  };
}

function compare(spec: TrialSpec, by: Map<string, Sample[]>): Comparison[] {
  const out: Comparison[] = [];
  const base = spec.variants[0]!.name;
  // Only runs that finished: a failed run still carries load, heap and profile numbers, so a variant that
  // never worked would otherwise read as no different, or even better.
  const numbers = (name: string, metric: string) =>
    (by.get(name) ?? [])
      .filter((s) => s.ok)
      .map((s) => s.metrics[metric])
      .filter((v): v is number => typeof v === 'number');
  const metrics = new Set((by.get(base) ?? []).flatMap((s) => Object.keys(s.metrics)));
  for (const v of spec.variants.slice(1)) {
    for (const metric of metrics) {
      const a = numbers(base, metric);
      const b = numbers(v.name, metric);
      if (a.length < MIN_COMPARE || b.length < MIN_COMPARE) continue;
      const ci = bootstrapDiffCI(b, a, median, { seed: SEED });
      const diff = r3(ci.estimate);
      const lo = r3(ci.lo);
      const hi = r3(ci.hi);
      const clear = lo > 0 || hi < 0;
      const way = betterOf(spec, metric);
      const better = !clear || !way ? null : (way === 'lower') === diff < 0 ? 'yes' : 'no';
      const text = clear
        ? `${v.name}'s ${metric} median is ${r3(Math.abs(diff))} ${diff > 0 ? 'higher' : 'lower'} than ${base}'s (95% CI ${lo} to ${hi}, ${b.length} and ${a.length} runs)${better ? `: ${better === 'yes' ? 'better' : 'worse'}` : ''}`
        : `${v.name} vs ${base} on ${metric}: no clear difference (median ${diff >= 0 ? '+' : ''}${diff}, 95% CI ${lo} to ${hi})`;
      out.push({ metric, variant: v.name, baseline: base, diff, lo, hi, better, text });
    }
  }
  return out;
}

/** Everything the runs say, per variant and against the first variant. Raw metrics are cleaned here. */
export function summarize(spec: TrialSpec, raw: Sample[]): Pick<TrialReport, 'variants' | 'compare' | 'samples' | 'notes'> {
  const samples = raw.map((s) => ({ ...s, metrics: metricsOf(s.metrics) }));
  const by = new Map<string, Sample[]>(spec.variants.map((v) => [v.name, []]));
  for (const s of samples) by.get(s.variant)?.push(s);
  const variants = spec.variants.map((v) => variantResult(v.name, by.get(v.name)!));
  const notes: string[] = [];
  for (const v of variants) {
    if (v.runs && !v.ok) notes.push(`${v.name} failed all ${v.runs} runs: ${v.errors[0]?.message ?? 'no result'}`);
    else if (v.ok < v.runs) notes.push(`${v.name} failed ${v.runs - v.ok} of ${v.runs} runs, left out of its numbers: ${v.errors[0]?.message ?? 'no result'}`);
  }
  if (samples.some((s) => PARSE_ERROR.test(s.error ?? '') || s.uncaught.some((u) => PARSE_ERROR.test(u))))
    notes.push("The device's engine couldn't parse some of the code: write the measure, setup and checks in ES5 (no arrow functions, let or const, template strings, classes or spread).");
  return { variants, compare: compare(spec, by), samples, notes };
}

export interface TrialControl {
  /** Runs a script on the device; rejects when the page throws or doesn't answer. */
  start(script: string): Promise<void>;
  /** Runs a script on the device and resolves with its value. */
  poll(script: string): Promise<unknown>;
  /** Resolves when the device says run `id` is done, or after `ms`. Without it the laptop polls every pollMs. */
  wait?(id: string, ms: number): Promise<void>;
  sleep(ms: number): Promise<void>;
  /** The page is still connected. */
  alive(): boolean;
  /** The caller stopped waiting: no more runs start. */
  stopped?(): boolean;
}

interface RunResult {
  metrics: Metrics;
  error: string | null;
  uncaught: string[];
  ms: number | null;
}

async function runOne(ctl: TrialControl, id: string, script: string, timeoutMs: number, pollMs: number, graceMs: number, fallbackMs: number): Promise<RunResult> {
  try {
    await ctl.start(script);
  } catch (e) {
    return { metrics: {}, error: `could not start: ${(e as Error).message}`, uncaught: [], ms: null };
  }
  const deadline = Date.now() + timeoutMs + graceMs;
  let last = '';
  while (Date.now() < deadline) {
    // The device is being measured: it says when it is done, rather than being asked every few frames.
    if (ctl.wait) await ctl.wait(id, fallbackMs);
    else await ctl.sleep(pollMs);
    let r: unknown;
    try {
      r = await ctl.poll(pollScript(id));
    } catch (e) {
      last = (e as Error).message;
      continue;
    }
    if (!isObj(r)) continue;
    if (r.gone) return { metrics: {}, error: 'the page reloaded or crashed during the run', uncaught: [], ms: null };
    if (!r.done) continue;
    const uncaught = Array.isArray(r.errors) ? r.errors.map((x) => String(x).slice(0, MAX_STR)) : [];
    return { metrics: metricsOf(r.metrics), error: typeof r.error === 'string' ? r.error.slice(0, 400) : null, uncaught, ms: typeof r.ms === 'number' ? r3(r.ms) : null };
  }
  return { metrics: {}, error: `no result from the device in ${Math.round((timeoutMs + graceMs) / 1000)} s${last ? ` (${last})` : ''}`, uncaught: [], ms: null };
}

const runId = (kind: string) => `${kind}-${randomBytes(6).toString('hex')}`;

/** Runs a parsed spec on one device. `paths`: each asset's path under teleport, from TrialFiles. */
export async function runTrial(
  ctl: TrialControl,
  spec: TrialSpec,
  device: { id: string; ua: string },
  opts: { paths?: Record<string, string>; pollMs?: number; graceMs?: number; budgetMs?: number; fallbackMs?: number; onProgress?: (done: number, total: number) => void } = {},
): Promise<TrialReport> {
  const { paths = {}, pollMs = POLL_MS, graceMs = GRACE_MS, budgetMs = BUDGET_MS, fallbackMs = FALLBACK_POLL_MS } = opts;
  const presses = spec.keys.map((k) => pressFor(KEY[k]));
  const startedAt = Date.now();
  const notes: string[] = [];
  const samples: Sample[] = [];
  let checks: Metrics | null = null;
  let checksError: string | null = null;
  let truncated = false;
  {
    if (Object.keys(spec.checks).length) {
      const id = runId('checks');
      const probe: TrialSpec = { ...spec, where: 'frame', measure: checksMeasure(spec.checks), observeMs: 0, keys: [], profile: false, variants: [{ name: 'checks', before: '', scripts: [], html: '', setup: '', vars: { checks: spec.checks } }] };
      const r = await runOne(ctl, id, startScript(id, probe, 0, 0, {}, []), spec.timeoutMs, pollMs, graceMs, fallbackMs);
      checks = r.metrics;
      checksError = r.error;
    }
    for (const { variant, round } of order(spec.variants.length, spec.runs)) {
      // A run may take its timeout and the grace, so one starts only if it ends within the budget,
      // and the answer reaches q before its 300 s timeout.
      if (Date.now() - startedAt + spec.timeoutMs + graceMs > budgetMs) {
        truncated = true;
        break;
      }
      if (!ctl.alive()) {
        notes.push('the device went away during the trial');
        truncated = true;
        break;
      }
      if (ctl.stopped?.()) {
        notes.push(`stopped after ${samples.length} of ${spec.variants.length * spec.runs} runs: the caller stopped waiting`);
        truncated = true;
        break;
      }
      const id = runId('run');
      const r = await runOne(ctl, id, startScript(id, spec, variant, round, paths, presses), spec.timeoutMs, pollMs, graceMs, fallbackMs);
      samples.push({ variant: spec.variants[variant]!.name, round, ok: r.error === null, ...r });
      opts.onProgress?.(samples.length, spec.variants.length * spec.runs);
    }
  }
  if (truncated && !notes.length) notes.push(`stopped after ${samples.length} runs to answer within ${Math.round(budgetMs / 1000)} s`);
  const s = summarize(spec, samples);
  return {
    name: spec.name,
    device: { ...device, engine: describeUa(device.ua) },
    startedAt,
    ms: Date.now() - startedAt,
    truncated,
    notes: [...s.notes, ...profileNotes(spec, s), ...notes],
    variants: s.variants,
    compare: s.compare,
    checks,
    checksError,
    samples: s.samples,
  };
}

// ---- Files the laptop serves for a trial -----------------------------------------------------------

type Target = { kind: 'file'; path: string } | { kind: 'dir'; path: string } | { kind: 'url'; url: string } | { kind: 'prefix'; url: string };

// Media types the app's table leaves out, for streams served from a folder.
const MEDIA: Record<string, string> = {
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.mpd': 'application/dash+xml',
  '.ts': 'video/mp2t',
  '.m4s': 'video/iso.segment',
  '.m4v': 'video/mp4',
  '.m4a': 'audio/mp4',
  '.mp3': 'audio/mpeg',
  '.aac': 'audio/aac',
  '.vtt': 'text/vtt',
  '.jxl': 'image/jxl',
  '.heic': 'image/heic',
  '.bmp': 'image/bmp',
};
const mediaType = (file: string) => MEDIA[extname(file).toLowerCase()] ?? typeOf(file);

const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'range', 'access-control-expose-headers': 'content-length, content-range', 'timing-allow-origin': '*', 'cache-control': 'no-store' };

/** Local files and remote URLs under unguessable paths, for as long as the last `max` registered. */
export class TrialFiles {
  private map = new Map<string, Target>();
  constructor(private max = 64) {}

  /** A path under teleport for an absolute path or an http(s) URL; a trailing slash serves the folder or prefix. */
  register(target: string): string {
    const token = randomBytes(8).toString('hex');
    let t: Target;
    let tail = '';
    if (isUrl(target)) {
      t = target.endsWith('/') ? { kind: 'prefix', url: target } : { kind: 'url', url: target };
      if (t.kind === 'url') tail = encodeURIComponent(basename(new URL(target).pathname) || 'file');
    } else {
      if (!existsSync(target)) throw new Error(`no file at ${target}`);
      const dir = statSync(target).isDirectory();
      t = dir ? { kind: 'dir', path: target.replace(/\/+$/, '') } : { kind: 'file', path: target };
      if (!dir) tail = encodeURIComponent(basename(target));
    }
    this.map.set(token, t);
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value!);
    return `${TRIAL_BASE}${token}/${tail}`;
  }

  resolve(token: string): Target | null {
    return this.map.get(token) ?? null;
  }

  /** Serves `rest` (the path after TRIAL_BASE) to the device, with ranges, CORS and no caching. */
  async serve(rest: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const at = rest.indexOf('/');
    const t = this.resolve(at < 0 ? rest : rest.slice(0, at));
    const tail = at < 0 ? '' : rest.slice(at + 1);
    if (req.method === 'OPTIONS') return void res.writeHead(204, CORS).end();
    if (!t) return void res.writeHead(404, { ...CORS, 'content-type': 'text/plain' }).end('no such trial file: it was for an earlier trial');
    if (t.kind === 'file') return sendRange(req, res, t.path);
    if (t.kind === 'dir') {
      let rel: string;
      try {
        rel = decodeURIComponent(tail);
      } catch {
        return void res.writeHead(400, CORS).end();
      }
      let file = resolve(t.path, '.' + sep + rel);
      if (file !== t.path && !file.startsWith(t.path + sep)) return void res.writeHead(404, CORS).end();
      if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
      if (!existsSync(file)) return void res.writeHead(404, { ...CORS, 'content-type': 'text/plain' }).end('not found');
      return sendRange(req, res, file);
    }
    const url = t.kind === 'url' ? t.url : new URL(tail, t.url).href;
    if (t.kind === 'prefix' && !url.startsWith(t.url)) return void res.writeHead(404, CORS).end();
    const headers: Record<string, string> = {};
    if (typeof req.headers.range === 'string') headers.range = req.headers.range;
    let up: Response;
    try {
      up = await fetch(url, { headers });
    } catch (e) {
      return void res.writeHead(502, { ...CORS, 'content-type': 'text/plain' }).end(`teleport couldn't fetch ${url}: ${(e as Error).message}`);
    }
    const out: Record<string, string> = { ...CORS, 'content-type': up.headers.get('content-type') ?? mediaType(new URL(url).pathname) };
    for (const h of ['content-length', 'content-range', 'accept-ranges']) {
      const v = up.headers.get(h);
      if (v) out[h] = v;
    }
    res.writeHead(up.status, out);
    if (!up.body || req.method === 'HEAD') return void res.end();
    Readable.fromWeb(up.body as Parameters<typeof Readable.fromWeb>[0]).on('error', () => res.destroy()).pipe(res);
  }
}

function sendRange(req: IncomingMessage, res: ServerResponse, file: string) {
  const size = statSync(file).size;
  const head = { ...CORS, 'content-type': mediaType(file), 'accept-ranges': 'bytes' };
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''));
  if (m && (m[1] || m[2])) {
    const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
    const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
    if (start > end || start >= size) return void res.writeHead(416, { ...head, 'content-range': `bytes */${size}` }).end();
    res.writeHead(206, { ...head, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': String(end - start + 1) });
    if (req.method === 'HEAD') return void res.end();
    return void createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...head, 'content-length': String(size) });
  if (req.method === 'HEAD') return void res.end();
  createReadStream(file).pipe(res);
}
