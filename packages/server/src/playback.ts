// What is playing on a device right now, read generically: every <video>/<audio> element, the player
// library driving it (Shaka, hls.js, dash.js, video.js, or none), its tracks and manifest, and a
// title for the content so runs can be told apart. One ES5 script, run once in the page through
// the eval route; it reads, it never changes playback. The laptop then fetches the manifest itself
// (it went through teleport, or is public) and parses the ladder, so the device does no parsing.

import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
/** ES5: answers a plain object describing playback in the page. */
export const PLAYBACK_SCRIPT = `(function(){
var W=window,D=document,out={title:null,url:location.href,elements:[],players:[],manifests:[],mse:[]};
function s(v,n){return v===undefined||v===null?null:String(v).slice(0,n||300)}
function rng(r){var a=[];try{for(var i=0;i<r.length&&i<8;i++)a.push([Math.round(r.start(i)*10)/10,Math.round(r.end(i)*10)/10])}catch(e){}return a}
var EC={1:'ABORTED',2:'NETWORK',3:'DECODE',4:'SRC_NOT_SUPPORTED'};
var els=D.querySelectorAll('video,audio');
for(var i=0;i<els.length;i++){var e=els[i],o={tag:e.tagName.toLowerCase(),src:s(e.currentSrc||e.src),w:e.videoWidth||null,h:e.videoHeight||null,
t:Math.round(e.currentTime*10)/10,dur:isFinite(e.duration)?Math.round(e.duration):s(e.duration),paused:e.paused,ended:e.ended,rs:e.readyState,ns:e.networkState,
rate:e.playbackRate,muted:e.muted,vol:e.volume,buffered:rng(e.buffered),mediaKeys:!!e.mediaKeys,
keySystem:e.mediaKeys&&e.mediaKeys.keySystem?s(e.mediaKeys.keySystem):null,
error:e.error?(EC[e.error.code]||e.error.code)+(e.error.message?': '+s(e.error.message):''):null,
box:(function(){try{var r=e.getBoundingClientRect();return [Math.round(r.left),Math.round(r.top),Math.round(r.width),Math.round(r.height)]}catch(x){return null}})()};
try{var q=e.getVideoPlaybackQuality&&e.getVideoPlaybackQuality();if(q)o.quality={total:q.totalVideoFrames,dropped:q.droppedVideoFrames,corrupt:q.corruptedVideoFrames}}catch(x){}
var tr=function(l,k){var a=[];if(!l)return null;for(var j=0;j<l.length&&j<16;j++){var t=l[j];a.push({id:s(t.id,60),kind:s(t.kind,30),label:s(t.label,80),lang:s(t.language,20),on:k?!!t.selected:(t.enabled!==undefined?!!t.enabled:s(t.mode,10))})}return a};
o.audioTracks=tr(e.audioTracks,false);o.videoTracks=tr(e.videoTracks,true);o.textTracks=tr(e.textTracks,false);
out.elements.push(o)}
function shaka(p){var r={lib:'shaka',version:W.shaka&&W.shaka.Player?s(W.shaka.Player.version):null};
try{r.manifestUri=s(p.getAssetUri?p.getAssetUri():p.getManifestUri(),1000)}catch(x){}
try{r.type=s(p.getManifestType&&p.getManifestType())}catch(x){}
try{r.live=p.isLive()}catch(x){}
try{r.drm=p.drmInfo()?{ks:s(p.drmInfo().keySystem),video:s(p.drmInfo().videoRobustness),audio:s(p.drmInfo().audioRobustness)}:null}catch(x){}
try{var st=p.getStats();r.stats={w:st.width,h:st.height,bw:Math.round(st.estimatedBandwidth),stream:st.streamBandwidth,decoded:st.decodedFrames,dropped:st.droppedFrames,loadS:st.loadLatency,manifestS:st.manifestTimeSeconds,drmS:st.drmTimeSeconds,licenseS:st.licenseTime,playingS:st.playTime,bufferingS:st.bufferingTime,switches:(st.switchHistory||[]).length,stalls:st.stallsDetected,gaps:st.gapsJumped}}catch(x){}
try{r.tracks=p.getVariantTracks().slice(0,60).map(function(t){return {id:t.id,active:t.active,bw:t.bandwidth,w:t.width,h:t.height,fps:t.frameRate,v:s(t.videoCodec,40),a:s(t.audioCodec,40),ch:t.channelsCount,lang:s(t.language,20),hdr:s(t.hdr,20),mime:s(t.mimeType,40),roles:t.roles||[]}})}catch(x){}
try{r.text=p.getTextTracks().slice(0,30).map(function(t){return {lang:s(t.language,20),kind:s(t.kind,20),active:t.active,mime:s(t.mimeType,40)}})}catch(x){}
return r}
var seen=[];function add(r,o){if(seen.indexOf(o)<0){seen.push(o);out.players.push(r)}}
try{for(var k in W){var x;try{x=W[k]}catch(y){continue}if(!x||typeof x!=='object')continue;
if(typeof x.getVariantTracks==='function'&&typeof x.getStats==='function')add(shaka(x),x);
else if(x.levels&&x.media!==undefined&&typeof x.loadSource==='function'){add({lib:'hls.js',version:W.Hls?s(W.Hls.version):null,manifestUri:s(x.url,1000),level:x.currentLevel,tracks:(x.levels||[]).slice(0,60).map(function(l){return {bw:l.bitrate,w:l.width,h:l.height,v:s(l.videoCodec,40),a:s(l.audioCodec,40)}}),audio:(x.audioTracks||[]).map(function(t){return {lang:s(t.lang,20),name:s(t.name,60)}})},x)}
else if(typeof x.getBitrateInfoListFor==='function'){var dr={lib:'dash.js',version:x.getVersion?s(x.getVersion()):null};try{dr.manifestUri=s(x.getSource(),1000)}catch(y){}try{dr.tracks=x.getBitrateInfoListFor('video').map(function(b){return {bw:b.bitrate,w:b.width,h:b.height}})}catch(y){}add(dr,x)}}}catch(e){}
try{if(W.videojs&&W.videojs.getPlayers){var ps=W.videojs.getPlayers();for(var n in ps)if(ps[n])add({lib:'video.js',version:s(W.videojs.VERSION),manifestUri:s(ps[n].currentSrc(),1000)},ps[n])}}catch(e){}
var P=W.performance;try{var rs=P&&P.getEntriesByType?P.getEntriesByType('resource'):[];for(var j=0;j<rs.length;j++){var u=rs[j].name;if(/\\.(mpd|m3u8|ism\\/manifest)(\\?|$)|\\/manifest(\\(|\\?|$)/i.test(u)&&out.manifests.indexOf(u)<0)out.manifests.push(s(u,1000))}}catch(e){}
var md=W.navigator&&navigator.mediaSession&&navigator.mediaSession.metadata;
var cand=[md&&md.title,(function(){var m=D.querySelector('meta[property="og:title"]');return m&&m.content})(),
(function(){try{var el=D.querySelector('[data-testid*=title],[class*=title] h1,[class*=Title] h1,h1');return el&&el.textContent}catch(e){return null}})(),D.title];
for(var c=0;c<cand.length-1;c++){var t=cand[c]&&String(cand[c]).replace(/\\s+/g,' ').trim();if(t){out.title=t.slice(0,160);break}}
out.titleCandidates=cand.map(function(x){return x?String(x).replace(/\\s+/g,' ').trim().slice(0,160):null});
var segs=(location.pathname+'/'+location.hash.replace(/^#!?/,'')).split(/[\\/?&=]/),pm=null;
for(var g=0;g<segs.length&&!pm;g++)if(/^\\d{4,}$|^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$|^[A-Za-z0-9]{10,}$/.test(segs[g])&&/\\d/.test(segs[g]))pm=segs[g];
out.contentId=pm;out.route=s(location.pathname,120);
if(!out.title&&D.title)out.title=String(D.title).trim().slice(0,100)+(pm?' '+pm:'');
return out})()`;

/** ES5: the player's live configuration (Shaka getConfiguration, hls.js config, dash.js getSettings),
 *  so advice can name the setting to change. Licence servers, headers, keys and certificates are
 *  reduced to their names; functions to "fn". Answers a JSON string, so the engine's own
 *  serialiser bounds the size. */
export const PLAYER_CONFIG_SCRIPT = `(function(){
var W=window,SECRET=/servers|headers|clearKeys|serverCertificate|licenseServer|token|auth|cookie|password|secret/i;
function pick(o,d){if(o===null||o===undefined)return o;var t=typeof o;if(t==='function')return 'fn';if(t!=='object')return o;
if(d>5)return '…';if(o.length!==undefined&&typeof o.slice==='function'){var a=[];for(var i=0;i<o.length&&i<40;i++)a.push(pick(o[i],d+1));return a}
var r={};for(var k in o){var v;try{v=o[k]}catch(e){continue}if(SECRET.test(k)){r[k]=v&&typeof v==='object'?Object.keys(v):typeof v;continue}r[k]=pick(v,d+1)}return r}
var out={lib:null,version:null,config:null,loadMode:null,mse:{}};
try{for(var k in W){var x;try{x=W[k]}catch(y){continue}if(!x||typeof x!=='object')continue;
if(typeof x.getConfiguration==='function'&&typeof x.getVariantTracks==='function'){out.lib='shaka';out.version=W.shaka&&W.shaka.Player?String(W.shaka.Player.version):null;out.config=pick(x.getConfiguration(),0);try{out.loadMode=x.getLoadMode()}catch(e){}break}
if(x.config&&typeof x.loadSource==='function'&&x.levels!==undefined){out.lib='hls.js';out.version=W.Hls?String(W.Hls.version):null;out.config=pick(x.config,0);break}
if(typeof x.getSettings==='function'&&typeof x.getBitrateInfoListFor==='function'){out.lib='dash.js';out.version=x.getVersion?String(x.getVersion()):null;out.config=pick(x.getSettings(),0);break}}}catch(e){}
try{var SB=W.SourceBuffer;out.mse.changeType=!!(SB&&SB.prototype&&'changeType' in SB.prototype)}catch(e){}
return JSON.stringify(out)})()`;

export interface PlayerConfig {
  lib: 'shaka' | 'hls.js' | 'dash.js' | null;
  version: string | null;
  config: Record<string, unknown> | null;
  loadMode: unknown;
  mse: { changeType?: boolean };
}

/** The eval route's answer to PLAYER_CONFIG_SCRIPT, parsed; an { error } stays one. */
export function playerConfig(answer: unknown): PlayerConfig | { error: string } {
  if (answer && typeof answer === 'object' && 'error' in answer) return { error: String(answer.error) };
  const v = answer && typeof answer === 'object' && 'value' in answer ? answer.value : answer;
  if (typeof v !== 'string') return { error: 'no answer' };
  try {
    const p: unknown = JSON.parse(v);
    return p && typeof p === 'object' ? (p as PlayerConfig) : { error: 'not an object' };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

/** ES5: every request the page made, from the engine's resource timing, including those that never
 *  passed through teleport (APIs, image CDNs, media segments). Query values are kept only for short,
 *  harmless keys (sizes, quality, format); every other value is dropped, so no token leaves the page.
 *  Cross-origin entries without Timing-Allow-Origin have no duration or size: that is the engine's rule. */
export const RESOURCES_SCRIPT = `(function(){
var P=window.performance,KEEP=/^(w|h|width|height|resize|size|quality|q|fmt|format|dpr|fit|crop|page|limit|offset|lang)$/i;
var out={now:P&&P.now?Math.round(P.now()):null,bufferFull:false,entries:[]};
function clean(u){var q=u.indexOf('?'),base=(q<0?u:u.slice(0,q)).split('#')[0],ps=q<0?[]:u.slice(q+1).split('#')[0].split('&'),kept=[];
for(var i=0;i<ps.length&&i<20;i++){var kv=ps[i].split('='),k=kv[0];if(!k)continue;var v=kv.slice(1).join('=');kept.push(KEEP.test(k)&&v.length<24?k+'='+v:k)}
base=base.replace(/eyJ[\\w-]{8,}\\.[\\w-]{8,}\\.[\\w-]{8,}/g,'<jwt>');return base.slice(0,200)+(kept.length?'?'+kept.join('&'):'')}
try{var rs=P.getEntriesByType('resource');out.bufferFull=rs.length>=150;
for(var i=0;i<rs.length&&i<600;i++){var e=rs[i];out.entries.push({u:clean(e.name),t:e.initiatorType,s:Math.round(e.startTime),d:Math.round(e.duration),b:e.transferSize===undefined?null:e.transferSize,z:e.decodedBodySize===undefined?null:e.decodedBodySize,ttfb:e.responseStart>0&&e.requestStart>0?Math.round(e.responseStart-e.requestStart):null})}}catch(e){}
try{var vs=document.querySelectorAll('video'),best=0;for(var j=0;j<vs.length;j++)if(vs[j].currentTime>best)best=vs[j].currentTime;out.videoT=vs.length?Math.round(best*1000):null}catch(e){}
return JSON.stringify(out)})()`;

export interface ResourceEntry {
  /** URL without query values (except harmless keys) and with any JWT in the path replaced. */
  u: string;
  t: string;
  /** Start, ms after the page's time origin. */
  s: number;
  d: number;
  b: number | null;
  z: number | null;
  ttfb: number | null;
}

export interface Resources {
  now: number | null;
  /** The engine keeps 150 entries by default: older ones are gone. */
  bufferFull: boolean;
  entries: ResourceEntry[];
  videoT: number | null;
}

/** The eval route's answer to RESOURCES_SCRIPT, parsed. */
export function resources(answer: unknown): Resources | { error: string } {
  if (answer && typeof answer === 'object' && 'error' in answer) return { error: String(answer.error) };
  const v = answer && typeof answer === 'object' && 'value' in answer ? answer.value : answer;
  if (typeof v !== 'string') return { error: 'no answer' };
  try {
    const p: unknown = JSON.parse(v);
    return p && typeof p === 'object' && 'entries' in p ? (p as Resources) : { error: 'not resources' };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

export interface Rendition {
  kind: 'video' | 'audio' | 'text';
  id: string | null;
  codecs: string | null;
  mime: string | null;
  bandwidth: number | null;
  width: number | null;
  height: number | null;
  frameRate: string | null;
  channels: string | null;
  lang: string | null;
  hdr: string | null;
  drm: string[];
}

export interface ManifestInfo {
  url: string;
  type: 'dash' | 'hls' | 'unknown';
  error: string | null;
  live: boolean | null;
  durationS: number | null;
  renditions: Rendition[];
}

const attr = (tag: string, name: string): string | null => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1] ?? null;
const n = (v: string | null) => (v === null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const DRM_IDS: Record<string, string> = {
  'edef8ba9-79d6-4ace-a3c8-27dcd51d21ed': 'widevine',
  '9a04f079-9840-4286-ab92-e65be0885f95': 'playready',
  '94ce86fb-07ff-4f43-adb8-93d2fa968ca2': 'fairplay',
  'e2719d58-a985-b3c9-781a-b030af78d30e': 'clearkey',
  '1077efec-c0b2-4d02-ace3-3c1e52e2fb4b': 'clearkey',
};
function drmOf(block: string): string[] {
  const out = new Set<string>();
  for (const m of block.matchAll(/schemeIdUri="urn:uuid:([0-9a-f-]+)"/gi)) out.add(DRM_IDS[m[1]!.toLowerCase()] ?? m[1]!);
  return [...out];
}
function isoS(d: string | null): number | null {
  const m = d && /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?$/.exec(d);
  return m ? Math.round((+(m[1] ?? 0)) * 86400 + (+(m[2] ?? 0)) * 3600 + (+(m[3] ?? 0)) * 60 + +(m[4] ?? 0)) : null;
}

/** DASH MPD → renditions. Regex over tags: no XML dependency, enough for the attributes that matter. */
export function parseMpd(xml: string): Omit<ManifestInfo, 'url' | 'error'> {
  const mpd = /<MPD\b[^>]*>/.exec(xml)?.[0] ?? '';
  const out: Rendition[] = [];
  for (const as of xml.matchAll(/<AdaptationSet\b([^>]*)>([\s\S]*?)<\/AdaptationSet>/g)) {
    const head = `<x ${as[1]}>`;
    const body = as[2]!;
    const drm = drmOf(body);
    const ct = attr(head, 'contentType') ?? attr(head, 'mimeType')?.split('/')[0] ?? null;
    const kind = (ct === 'audio' || ct === 'video' || ct === 'text' ? ct : /^application|text/.test(ct ?? '') ? 'text' : 'video') as Rendition['kind'];
    const ch = /<AudioChannelConfiguration\b[^>]*value="([^"]*)"/.exec(body)?.[1] ?? null;
    const hdr = /EssentialProperty[^>]*TransferCharacteristics"\s+value="(16|18)"/.exec(body) ? 'HDR' : null;
    for (const r of body.matchAll(/<Representation\b[^>]*>/g)) {
      const t = r[0];
      const g = (k: string) => attr(t, k) ?? attr(head, k);
      out.push({
        kind,
        id: attr(t, 'id'),
        codecs: g('codecs'),
        mime: g('mimeType'),
        bandwidth: n(attr(t, 'bandwidth')),
        width: n(g('width')),
        height: n(g('height')),
        frameRate: g('frameRate'),
        channels: ch,
        lang: attr(head, 'lang'),
        hdr,
        drm,
      });
    }
  }
  return { type: 'dash', live: mpd ? attr(mpd, 'type') === 'dynamic' : null, durationS: isoS(attr(mpd, 'mediaPresentationDuration')), renditions: out };
}

/** HLS master playlist → renditions. */
export function parseM3u8(text: string): Omit<ManifestInfo, 'url' | 'error'> {
  const out: Rendition[] = [];
  const a = (line: string, k: string) => new RegExp(`(?:^|,|:)${k}=("([^"]*)"|[^,]*)`).exec(line)?.[2] ?? new RegExp(`(?:^|,|:)${k}=([^,]*)`).exec(line)?.[1] ?? null;
  const drm = [...new Set([...text.matchAll(/KEYFORMAT="([^"]+)"/g)].map((m) => (/edef8ba9/i.test(m[1]!) ? 'widevine' : /playready/i.test(m[1]!) ? 'playready' : /streamingkeydelivery/.test(m[1]!) ? 'fairplay' : m[1]!)))];
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      const res = a(line, 'RESOLUTION')?.split('x');
      out.push({ kind: 'video', id: null, codecs: a(line, 'CODECS'), mime: null, bandwidth: n(a(line, 'BANDWIDTH')), width: n(res?.[0] ?? null), height: n(res?.[1] ?? null), frameRate: a(line, 'FRAME-RATE'), channels: null, lang: null, hdr: a(line, 'VIDEO-RANGE'), drm });
    } else if (line.startsWith('#EXT-X-MEDIA:')) {
      const t = a(line, 'TYPE');
      out.push({ kind: t === 'AUDIO' ? 'audio' : t === 'SUBTITLES' || t === 'CLOSED-CAPTIONS' ? 'text' : 'video', id: a(line, 'NAME'), codecs: null, mime: null, bandwidth: null, width: null, height: null, frameRate: null, channels: a(line, 'CHANNELS'), lang: a(line, 'LANGUAGE'), hdr: null, drm });
    }
  }
  return { type: 'hls', live: /#EXT-X-ENDLIST/.test(text) ? false : out.length ? null : true, durationS: null, renditions: out };
}

/** The default CAs plus the OS's (Node 22.15+), so a manifest fetch works behind a TLS-inspecting proxy the way curl does. */
function cas(): string[] | undefined {
  if (!('getCACertificates' in tls) || typeof tls.getCACertificates !== 'function') return undefined;
  try {
    return [...tls.getCACertificates('default'), ...tls.getCACertificates('system')];
  } catch {
    return undefined;
  }
}

/** GET as text, trusting the OS's certificates too. Executor form: Node 20 has no Promise.withResolvers. */
function getText(url: string, ms = 10_000, hops = 3): Promise<{ status: number; text: string }> {
  return new Promise((done, fail) => {
    const u = new URL(url);
    const get = u.protocol === 'https:' ? https.get : http.get;
    const req = get(u, { ca: u.protocol === 'https:' ? cas() : undefined, timeout: ms }, (res) => {
      const loc = res.headers.location;
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && loc && hops > 0) {
        res.resume();
        return void getText(new URL(loc, u).href, ms, hops - 1).then(done, fail);
      }
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => {
        if (text.length < 8_000_000) text += c;
      });
      res.on('end', () => done({ status: res.statusCode ?? 0, text }));
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', fail);
  });
}

/** Fetches and parses a manifest from the laptop. Never throws: an error says why. */
export async function readManifest(url: string): Promise<ManifestInfo> {
  const none = (error: string): ManifestInfo => ({ url, type: 'unknown', error, live: null, durationS: null, renditions: [] });
  try {
    const r = await getText(url);
    if (r.status >= 400) return none(`HTTP ${r.status}`);
    const parsed = /<MPD\b/.test(r.text) ? parseMpd(r.text) : r.text.startsWith('#EXTM3U') ? parseM3u8(r.text) : null;
    return parsed ? { url, error: null, ...parsed } : none('neither DASH nor HLS');
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    const code = 'code' in err ? String(err.code) : '';
    return none(/CERT|SELF_SIGNED/.test(code) ? `${code}: a proxy on this network re-signs TLS and Node doesn't trust it; set NODE_EXTRA_CA_CERTS to its certificate` : err.message);
  }
}

/** The player's variant tracks as renditions: the ladder as the device sees it, when the manifest can't be read here. */
export function renditionsFromTracks(tracks: unknown, drm: string | null): Rendition[] {
  const out: Rendition[] = [];
  const seen = new Set<string>();
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const t = (v: unknown) => (typeof v === 'string' && v ? v : null);
  const sys = drm ? [/widevine/.test(drm) ? 'widevine' : /playready/.test(drm) ? 'playready' : /fairplay|fps/.test(drm) ? 'fairplay' : /clearkey/.test(drm) ? 'clearkey' : drm] : [];
  for (const x of Array.isArray(tracks) ? tracks : []) {
    if (!x || typeof x !== 'object') continue;
    const o: Record<string, unknown> = { ...x };
    const v: Rendition = { kind: 'video', id: null, codecs: t(o.v), mime: t(o.mime), bandwidth: n(o.bw), width: n(o.w), height: n(o.h), frameRate: n(o.fps) === null ? null : String(o.fps), channels: null, lang: null, hdr: t(o.hdr), drm: sys };
    const a: Rendition = { kind: 'audio', id: null, codecs: t(o.a), mime: null, bandwidth: null, width: null, height: null, frameRate: null, channels: n(o.ch) === null ? null : String(o.ch), lang: t(o.lang), hdr: null, drm: sys };
    for (const r of [v, a]) {
      if (!r.codecs) continue;
      const key = JSON.stringify([r.kind, r.codecs, r.width, r.height, r.bandwidth, r.channels, r.lang]);
      if (!seen.has(key)) {
        seen.add(key);
        out.push(r);
      }
    }
  }
  return out;
}

export interface Risk {
  level: 'bad' | 'warn' | 'info';
  text: string;
}

/** Codec string → the media probe's key for it, so a manifest's codecs can be checked against what the device said. */
export function probeKeyOf(codec: string): string | null {
  const c = codec.trim().toLowerCase();
  if (/^avc[13]\.4200|^avc[13]\.42e0/.test(c)) return 'h264Baseline';
  if (/^avc[13]\.4d/.test(c)) return 'h264Main';
  if (/^avc[13]\.64/.test(c)) return 'h264High';
  if (/^(hev1|hvc1)\.2/.test(c)) return 'hevcMain10';
  if (/^hvc1/.test(c)) return 'hevcHvc1';
  if (/^hev1/.test(c)) return 'hevcMain';
  if (/^(dvh1|dvhe)/.test(c)) return 'dolbyVision';
  if (/^vp09\.02/.test(c)) return 'vp9p2';
  if (/^(vp09|vp9)/.test(c)) return 'vp9p0';
  if (/^av01/.test(c)) return 'av1';
  if (c === 'mp4a.40.2') return 'aac';
  if (c === 'mp4a.40.5' || c === 'mp4a.40.29') return 'heaac';
  if (c === 'ec-3') return 'eac3';
  if (c === 'ac-3') return 'ac3';
  if (c === 'opus') return 'opusMp4';
  if (c === 'flac') return 'flac';
  return null;
}

/**
 * Where this content and this device may not get along: codecs in the manifest the device said no
 * to, codec families that would force a codec switch mid-stream on an engine without changeType,
 * a ladder that tops out above the screen, DRM systems the device lacks. Each is a lead for verify,
 * not a finding: the media probe's yes is the browser's word.
 */
export function risks(renditions: Rendition[], media: Record<string, unknown> | null, screen: { w: number; h: number } | null): Risk[] {
  const out: Risk[] = [];
  const said = (k: string) => (media ? media[k] : undefined);
  const codecs = new Set(renditions.flatMap((r) => (r.codecs ?? '').split(',').map((x) => x.trim()).filter(Boolean)));
  for (const codec of codecs) {
    const k = probeKeyOf(codec);
    if (!k) out.push({ level: 'info', text: `${codec}: no probe check for this codec` });
    else if (said(k) === false) out.push({ level: 'bad', text: `${codec}: in the manifest, but MediaSource.isTypeSupported said no (${k}); the player must filter it out` });
  }
  const families = new Set([...codecs].map((c) => c.split('.')[0]!.replace(/^(hvc1|hev1)$/, 'hevc').replace(/^avc[13]$/, 'avc')).filter((c) => !/^(mp4a|ec-3|ac-3|opus|flac|stpp|wvtt)$/.test(c)));
  if (families.size > 1)
    out.push({ level: said('changeType') === false ? 'bad' : 'warn', text: `video codecs ${[...families].join(' + ')} in one ladder: an ABR switch between them needs SourceBuffer.changeType${said('changeType') === false ? ', which this engine lacks' : ''}` });
  const audio = new Set(renditions.filter((r) => r.kind === 'audio').flatMap((r) => (r.codecs ?? '').split(',')).filter(Boolean));
  if (audio.size > 1) out.push({ level: 'warn', text: `audio codecs ${[...audio].join(' + ')}: switching language or track can mean switching codec` });
  const top = Math.max(0, ...renditions.filter((r) => r.kind === 'video').map((r) => r.height ?? 0));
  if (screen && top > screen.h * 1.05) out.push({ level: 'info', text: `ladder tops out at ${top}p on a ${screen.h}p screen: decode cost without visible gain, unless the UI scales` });
  const drm = new Set(renditions.flatMap((r) => r.drm));
  for (const d of drm) if (['widevine', 'playready', 'fairplay', 'clearkey'].includes(d) && said(d) === false) out.push({ level: 'bad', text: `manifest offers ${d}, the device has no ${d}` });
  if (renditions.some((r) => r.hdr)) out.push({ level: 'warn', text: 'HDR renditions present: confirm the display and decoder take them (verify media)' });
  return out;
}
