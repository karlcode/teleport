// `tlpt verify`: plays real clips on the device instead of trusting isTypeSupported. Clips are made
// once on this laptop with ffmpeg (fragmented MP4, 2 s: the pixel aliens of aliens.ts in a silent
// film that turns into a disco, the clip's name in the corner, and a warbling tone for audio) and cached in
// ~/.cache/teleport/media; teleport serves them to the device as trial assets. Each codec is a
// trial variant that feeds its clip through MediaSource and counts as playing only when frames
// decode and the clock moves. Switch variants append a second clip after the first: across codecs
// (with changeType where the engine has it) and across resolutions. A ClearKey variant plays a
// CENC-encrypted clip with a licence made on the device, to time key setup without a server.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { crewFrames, SCENE_H, SCENE_W } from './aliens.js';

export const cacheDir = () => join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'teleport', 'media');

/** ClearKey's key and key id, hex. A test key: it protects nothing. */
const CK_KID = '0123456789abcdef0123456789abcdef';
const CK_KEY = 'fedcba9876543210fedcba9876543210';

interface Clip {
  name: string;
  /** What MediaSource is asked for. */
  mime: string;
  /** ffmpeg arguments, the input included. */
  args: string[];
  /** What a video clip says in its corner; its frames are drawn here and piped to ffmpeg. */
  label?: string;
  w: number;
  h: number;
}

/** Frames a second, and seconds, of every video clip. */
const FPS = 25;
const SECONDS = 2;
// The crew's frames arrive raw on stdin at the scene's size; nearest-neighbour scaling keeps each of
// its pixels a square block at the clip's size.
const V = (enc: string[], w: number, h: number, fps = FPS) => [
  '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${SCENE_W}x${SCENE_H}`, '-r', String(fps), '-i', '-',
  '-vf', `scale=${w}:${h}:flags=neighbor`, '-pix_fmt', 'yuv420p', ...enc, '-g', String(fps), '-an',
];
// A little alien warble: a tone that wobbles in pitch, rather than a flat 440 Hz.
const A = (enc: string[], ch = 2) => ['-f', 'lavfi', '-i', `aevalsrc=0.4*sin(2*PI*t*(520+160*sin(2*PI*3*t))):s=48000:d=${SECONDS}`, '-ac', String(ch), ...enc, '-vn'];
// delay_moov: the MP4 muxer can't write AC-3's header before its first packet, and wrote an empty
// file for ac3 and eac3 without it.
const FRAG = ['-movflags', 'frag_keyframe+empty_moov+default_base_moof+delay_moov', '-f', 'mp4'];

export const CLIPS: Clip[] = [
  { name: 'h264-1080', mime: 'video/mp4; codecs="avc1.640028"', args: [...V(['-c:v', 'libx264', '-profile:v', 'high', '-level', '4.0'], 1920, 1080), ...FRAG], w: 1920, h: 1080 },
  { name: 'h264-720', mime: 'video/mp4; codecs="avc1.64001f"', args: [...V(['-c:v', 'libx264', '-profile:v', 'high', '-level', '3.1'], 1280, 720), ...FRAG], w: 1280, h: 720 },
  { name: 'hevc-1080', mime: 'video/mp4; codecs="hvc1.1.6.L120.90"', args: [...V(['-c:v', 'libx265', '-tag:v', 'hvc1', '-x265-params', 'log-level=error'], 1920, 1080), ...FRAG], w: 1920, h: 1080 },
  { name: 'hevc-2160', mime: 'video/mp4; codecs="hvc1.1.6.L150.90"', args: [...V(['-c:v', 'libx265', '-tag:v', 'hvc1', '-x265-params', 'log-level=error'], 3840, 2160), ...FRAG], w: 3840, h: 2160 },
  { name: 'hevc10-2160', mime: 'video/mp4; codecs="hvc1.2.4.L150.90"', args: [...V(['-c:v', 'libx265', '-tag:v', 'hvc1', '-x265-params', 'log-level=error', '-pix_fmt', 'yuv420p10le', '-profile:v', 'main10'], 3840, 2160), ...FRAG], w: 3840, h: 2160 },
  { name: 'vp9-1080', mime: 'video/mp4; codecs="vp09.00.40.08"', args: [...V(['-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', '2M'], 1920, 1080), ...FRAG], w: 1920, h: 1080 },
  { name: 'av1-1080', mime: 'video/mp4; codecs="av01.0.08M.08"', args: [...V(['-c:v', 'libsvtav1', '-preset', '12'], 1920, 1080), ...FRAG], w: 1920, h: 1080 },
  { name: 'aac', mime: 'audio/mp4; codecs="mp4a.40.2"', args: [...A(['-c:a', 'aac']), ...FRAG], w: 0, h: 0 },
  { name: 'ac3', mime: 'audio/mp4; codecs="ac-3"', args: [...A(['-c:a', 'ac3'], 6), ...FRAG], w: 0, h: 0 },
  { name: 'eac3', mime: 'audio/mp4; codecs="ec-3"', args: [...A(['-c:a', 'eac3'], 6), ...FRAG], w: 0, h: 0 },
  { name: 'opus', mime: 'audio/mp4; codecs="opus"', args: [...A(['-c:a', 'libopus', '-strict', '-2']), ...FRAG], w: 0, h: 0 },
  { name: 'h264-1080-cenc', mime: 'video/mp4; codecs="avc1.640028"', args: [...V(['-c:v', 'libx264', '-profile:v', 'high', '-level', '4.0'], 1920, 1080), '-encryption_scheme', 'cenc-aes-ctr', '-encryption_key', CK_KEY, '-encryption_kid', CK_KID, ...FRAG], w: 1920, h: 1080 },
].map((c) => (c.w ? { ...c, label: c.name.replace(/-/g, ' ') } : c));

/** In each cached clip's file name, so a change to what the clips show makes them again. */
const LOOK = 'disco';

/** Makes the clips that aren't cached yet; returns name → absolute path of those that could be made. */
export function ensureClips(log: (s: string) => void = () => {}): { paths: Record<string, string>; failed: Record<string, string> } {
  const dir = cacheDir();
  mkdirSync(dir, { recursive: true });
  const paths: Record<string, string> = {};
  const failed: Record<string, string> = {};
  for (const c of CLIPS) {
    const file = join(dir, `${c.name}.${LOOK}.mp4`);
    if (!existsSync(file) || statSync(file).size === 0) {
      log(`making ${c.name}`);
      try {
        const input = c.label ? crewFrames(FPS * SECONDS, FPS, c.label) : undefined;
        execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...c.args, file], { input, stdio: [input ? 'pipe' : 'ignore', 'ignore', 'pipe'], maxBuffer: 1 << 20 });
      } catch (e) {
        // What ffmpeg left behind is not a clip: the next run must make it again, not serve it.
        rmSync(file, { force: true });
        const err = e as { code?: string; stderr?: Buffer };
        failed[c.name] = err.code === 'ENOENT' ? 'ffmpeg is not installed' : String(err.stderr ?? e).trim().split('\n').pop()!;
        continue;
      }
    }
    paths[c.name] = file;
  }
  return { paths, failed };
}

/**
 * ES5 measure: plays T.vars.clips in order into one MediaSource. Between clips of different
 * types it uses changeType when the engine has it, else a fresh SourceBuffer. Reports whether it
 * played, time to first frame, frames decoded and dropped, and what failed.
 */
const MEASURE = `function(T){
var v=T.vars,d=document,el=d.createElement(v.audio?'audio':'video'),MS=window.MediaSource||window.WebKitMediaSource,t0=T.now(),i=0,sb=null,type=null,off=0,first=null,how='';
el.muted=true;el.style.cssText='position:fixed;left:0;top:0;width:100%;height:100%;background:#000';d.body.appendChild(el);
T.cleanup(function(){try{el.pause();el.removeAttribute('src');el.load()}catch(e){}});
if(!MS)return T.fail('no MediaSource');
for(var j=0;j<v.clips.length;j++)if(!MS.isTypeSupported(v.clips[j].mime))T.set('saidNo',1);
function fail(w){T.done({played:0,why:w,firstFrameMs:first,switchedBy:how||null})}
el.addEventListener('error',function(){fail('media error '+(el.error&&el.error.code)+(el.error&&el.error.message?': '+el.error.message:''))});
function hex(h){var a=new Uint8Array(h.length/2);for(var k=0;k<a.length;k++)a[k]=parseInt(h.substr(k*2,2),16);return a}
function b64u(a){var s='';for(var k=0;k<a.length;k++)s+=String.fromCharCode(a[k]);return btoa(s).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'')}
function get(u,cb){var x=new XMLHttpRequest();x.open('GET',u);x.responseType='arraybuffer';x.onload=function(){x.status<300?cb(x.response):fail('fetch '+x.status)};x.onerror=function(){fail('fetch failed')};x.send()}
function drm(cb){if(!v.clearkey)return cb();var t=T.now();
if(!navigator.requestMediaKeySystemAccess)return fail('no EME');
navigator.requestMediaKeySystemAccess('org.w3.clearkey',[{initDataTypes:['cenc','keyids'],videoCapabilities:[{contentType:v.clips[0].mime}]}]).then(function(a){return a.createMediaKeys()}).then(function(mk){
el.addEventListener('encrypted',function(ev){var s=mk.createSession();s.addEventListener('message',function(){
s.update(new TextEncoder().encode(JSON.stringify({keys:[{kty:'oct',k:b64u(hex(v.key)),kid:b64u(hex(v.kid))}]}))).then(function(){T.set('licenseMs',Math.round(T.now()-t))},function(e){fail('update: '+e)})});
s.generateRequest(ev.initDataType,ev.initData).catch(function(e){fail('generateRequest: '+e)})});
return el.setMediaKeys(mk)}).then(function(){T.set('keysMs',Math.round(T.now()-t));cb()},function(e){fail('clearkey: '+e)})}
function next(){if(i>=v.clips.length){try{ms.endOfStream()}catch(e){}return watch()}
var c=v.clips[i++];get(T.asset(c.name),function(buf){try{
if(!sb){sb=ms.addSourceBuffer(c.mime);type=c.mime}
else if(c.mime!==type){if(sb.changeType){sb.changeType(c.mime);how='changeType'}else{how='none';return fail('no changeType to switch '+type+' -> '+c.mime)}type=c.mime}
sb.timestampOffset=off;off+=2;sb.addEventListener('updateend',function u(){sb.removeEventListener('updateend',u);next()});sb.appendBuffer(buf)}catch(e){fail('append: '+e.message)}})}
function watch(){var start=el.currentTime;var p=el.play();if(p&&p.catch)p.catch(function(e){fail('play: '+e.message)});
setTimeout(function(){var q=el.getVideoPlaybackQuality?el.getVideoPlaybackQuality():null,moved=el.currentTime-start;
T.done({played:moved>0.5?1:0,movedS:Math.round(moved*100)/100,firstFrameMs:first,decoded:q?q.totalVideoFrames:(el.webkitDecodedFrameCount||null),dropped:q?q.droppedVideoFrames:(el.webkitDroppedFrameCount||null),width:el.videoWidth||null,height:el.videoHeight||null,switchedBy:how||null})},v.clips.length*2000+500)}
el.addEventListener('playing',function(){if(first===null)first=Math.round(T.now()-t0)});
var ms=new MS();el.src=URL.createObjectURL(ms);
ms.addEventListener('sourceopen',function(){drm(next)})}`;

const NAMES: Record<string, string[]> = {
  'h264 1080p': ['h264-1080'],
  'hevc 1080p': ['hevc-1080'],
  'hevc 2160p': ['hevc-2160'],
  'hevc 10-bit 2160p': ['hevc10-2160'],
  'vp9 1080p': ['vp9-1080'],
  'av1 1080p': ['av1-1080'],
  aac: ['aac'],
  'ac-3 5.1': ['ac3'],
  'e-ac-3 5.1': ['eac3'],
  opus: ['opus'],
  'switch h264 720p → 1080p': ['h264-720', 'h264-1080'],
  'switch hevc 1080p → 2160p': ['hevc-1080', 'hevc-2160'],
  'switch h264 → hevc': ['h264-1080', 'hevc-1080'],
  'switch hevc → h264': ['hevc-1080', 'h264-1080'],
  'clearkey h264': ['h264-1080-cenc'],
};

/** The verify trial spec, for `/api/trial`, with the variants whose clips exist (at most 8 per trial, so in parts). */
export function verifySpecs(paths: Record<string, string>, only?: string[]): Record<string, unknown>[] {
  const mime = Object.fromEntries(CLIPS.map((c) => [c.name, c.mime]));
  const variants = Object.entries(NAMES)
    .filter(([, clips]) => clips.every((c) => paths[c]))
    .filter(([n]) => !only?.length || only.some((w) => n.toLowerCase().includes(w.toLowerCase())))
    .map(([name, clips]) => ({ name, vars: { clips: clips.map((c) => ({ name: c, mime: mime[c] })), audio: !CLIPS.find((x) => x.name === clips[0])!.w, clearkey: clips[0]!.endsWith('-cenc'), key: CK_KEY, kid: CK_KID } }));
  const parts: Record<string, unknown>[] = [];
  for (let i = 0; i < variants.length; i += 8) {
    const vs = variants.slice(i, i + 8);
    const used = new Set(vs.flatMap((v) => v.vars.clips.map((c) => c.name)));
    parts.push({ name: `verify media ${i / 8 + 1}`, variants: vs, measure: MEASURE, runs: 2, timeoutMs: 20_000, assets: Object.fromEntries([...used].map((c) => [c, paths[c]!])), better: { played: 'higher', firstFrameMs: 'lower', dropped: 'lower' } });
  }
  return parts;
}

export interface Verdict {
  name: string;
  plays: boolean | null;
  runs: number;
  firstFrameMs: number | null;
  dropped: number | null;
  why: string | null;
  saidYes: boolean;
}

/** One line per variant from a trial report: did it play in every run, and if not, why. */
export function verdicts(report: { variants?: { name: string; runs: number; ok: number; numbers?: Record<string, { median: number }>; values?: Record<string, unknown>; errors?: { message: string }[] }[]; samples?: { variant: string; metrics: Record<string, unknown>; error: string | null }[] }): Verdict[] {
  return (report.variants ?? []).map((v) => {
    const s = (report.samples ?? []).filter((x) => x.variant === v.name);
    const played = s.map((x) => x.metrics.played);
    const why = s.map((x) => x.metrics.why ?? x.error).find((w) => w) ?? null;
    return {
      name: v.name,
      plays: s.length ? played.every((p) => p === 1) : null,
      runs: s.length,
      firstFrameMs: v.numbers?.firstFrameMs?.median ?? null,
      dropped: v.numbers?.dropped?.median ?? null,
      why: why === null ? null : String(why),
      saidYes: !s.some((x) => x.metrics.saidNo === 1),
    };
  });
}
