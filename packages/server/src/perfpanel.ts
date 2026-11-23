// DevTools' own Performance panel for a device that can't trace. When DevTools records, the laptop runs
// a capture and answers the panel's Tracing domain itself, from the raw events the agent sent:
// animation frames, long tasks, key → frame (with its probed phases) and network. The panel needs a few metadata events to
// lay out its tracks (TracingStartedInBrowser, a CrRendererMain thread, SetLayerTreeId); the shapes
// were found by ablation against the stock frontend.
import { RESOURCE_KINDS } from '@teleport/protocol';
import type { NetRecord, Timeline } from './analyze.js';
import { KEY_PHASES, type KeyPhases } from './live.js';
import { keyPhasesAt } from './session.js';

const BROWSER = 1;
const RENDERER = 2;
const MAIN = 10;
const COMPOSITOR = 11;
const FRAME = 'F1';
const TL = 'disabled-by-default-devtools.timeline';
/** Timer lag over this, with no long task recorded over it, is drawn as a task (engines without long tasks). */
const LAG_TASK_MS = 50;
const FRAME_GAP_MS = 1000;
const DEDUPE_MS = 50;

export interface PanelInput {
  timeline: Timeline;
  /** Agent clock, ms. */
  from: number;
  to: number;
  names: string[];
  network: NetRecord[];
  offsetMs: number;
  href: string;
}

type Ev = Record<string, unknown>;

const RESOURCE_TYPE: Record<string, string> = { script: 'Script', css: 'Stylesheet', link: 'Stylesheet', img: 'Image', xmlhttprequest: 'XHR', fetch: 'Fetch', video: 'Media', audio: 'Media', font: 'Font', navigation: 'Document', iframe: 'Document' };

function rows(cols: Record<string, number[]>, from: number, to: number) {
  const t = cols.t!;
  const out: number[] = [];
  for (let i = 0; i < t.length; i++) if (t[i]! >= from && t[i]! < to) out.push(i);
  return out;
}

function request(ev: Ev[], id: string, r: { start: number; ttfbMs: number | null; durMs: number; url: string; type: string; status: number; mime: string; bytes: number; failed: boolean }) {
  const us = (ms: number) => Math.round(ms * 1000);
  const common = { cat: 'devtools.timeline', ph: 'I', s: 't', pid: RENDERER, tid: MAIN };
  const ttfb = r.ttfbMs ?? -1;
  ev.push({ ...common, name: 'ResourceSendRequest', ts: us(r.start), args: { data: { requestId: id, frame: FRAME, url: r.url, requestMethod: 'GET', priority: 'High', renderBlocking: 'non_blocking', resourceType: r.type } } });
  ev.push({
    ...common,
    name: 'ResourceReceiveResponse',
    ts: us(r.start + Math.max(0, ttfb)),
    args: {
      data: {
        requestId: id, frame: FRAME, statusCode: r.status, mimeType: r.mime, encodedDataLength: 0, fromCache: false, fromServiceWorker: false, protocol: 'http/1.1',
        timing: { requestTime: r.start / 1000, proxyStart: -1, proxyEnd: -1, dnsStart: -1, dnsEnd: -1, connectStart: -1, connectEnd: -1, sslStart: -1, sslEnd: -1, workerStart: -1, workerReady: -1, pushStart: 0, pushEnd: 0, sendStart: 0, sendEnd: 0, receiveHeadersStart: ttfb, receiveHeadersEnd: ttfb },
      },
    },
  });
  ev.push({ ...common, name: 'ResourceFinish', ts: us(r.start + r.durMs), args: { data: { requestId: id, encodedDataLength: r.bytes, decodedBodyLength: r.bytes, didFail: r.failed, finishTime: (r.start + r.durMs) / 1000 } } });
}

/** The frame after a probed key: its rAF callbacks, style, layout and paint, back to back. */
function frameSpans(t: number, ph: KeyPhases) {
  if (KEY_PHASES.some((k) => ph[k] === null && k !== 'inputDelay')) return null;
  const start = t + ph.handlers! + ph.waitFrame!;
  const spans: { start: number; dur: number; event: Ev }[] = [];
  let at = start;
  const add = (dur: number, event: Ev) => {
    spans.push({ start: at, dur, event });
    at += dur;
  };
  add(ph.raf!, { name: 'FireAnimationFrame', args: { data: { frame: FRAME, id: 1 } } });
  add(ph.style!, { name: 'UpdateLayoutTree', args: { beginData: { frame: FRAME }, elementCount: 0 } });
  add(ph.layout!, { name: 'Layout', args: { beginData: { frame: FRAME, dirtyObjects: 0, partialLayout: false, totalObjects: 0 }, endData: { layoutRoots: [] } } });
  add(ph.paint!, { name: 'Paint', args: { data: { frame: FRAME, clip: [0, 0, 0, 0, 0, 0, 0, 0], nodeId: 0, layerId: 0 } } });
  return { start, end: at, spans };
}

/** Trace events in the shapes DevTools' Performance panel renders as frames, tasks, interactions and network. */
export function devtoolsTrace(p: PanelInput): Ev[] {
  const us = (ms: number) => Math.round(ms * 1000);
  const tl = p.timeline;
  const ev: Ev[] = [
    { name: 'process_name', ph: 'M', ts: 0, pid: BROWSER, tid: 0, cat: '__metadata', args: { name: 'Browser' } },
    { name: 'process_name', ph: 'M', ts: 0, pid: RENDERER, tid: 0, cat: '__metadata', args: { name: 'device (teleport)' } },
    { name: 'thread_name', ph: 'M', ts: 0, pid: RENDERER, tid: MAIN, cat: '__metadata', args: { name: 'CrRendererMain' } },
    { name: 'thread_name', ph: 'M', ts: 0, pid: RENDERER, tid: COMPOSITOR, cat: '__metadata', args: { name: 'Compositor' } },
    {
      name: 'TracingStartedInBrowser', cat: TL, ph: 'I', s: 't', ts: us(p.from), pid: BROWSER, tid: 1,
      args: { data: { frameTreeNodeId: 1, persistentIds: true, frames: [{ frame: FRAME, url: p.href || 'device', name: '', processId: RENDERER, isOutermostMainFrame: true, isInPrimaryMainFrame: true }] } },
    },
    { name: 'SetLayerTreeId', cat: TL, ph: 'I', s: 't', ts: us(p.from), pid: RENDERER, tid: MAIN, args: { data: { frame: FRAME, layerTreeId: 1 } } },
  ];

  const fr = tl.frame!;
  const fi = rows(fr, p.from, p.to);
  for (let k = 0; k + 1 < fi.length; k++) {
    const a = fr.t![fi[k]!]!;
    const b = fr.t![fi[k + 1]!]!;
    if (b - a >= FRAME_GAP_MS) continue;
    const args = { layerTreeId: 1, frameSeqId: k + 1 };
    ev.push({ name: 'BeginFrame', cat: `${TL}.frame`, ph: 'I', s: 't', ts: us(a), pid: RENDERER, tid: COMPOSITOR, args });
    ev.push({ name: 'DrawFrame', cat: `${TL}.frame`, ph: 'I', s: 't', ts: us(b - 0.5), pid: RENDERER, tid: COMPOSITOR, args });
  }

  // Probed keys become a key task and a frame task with the phases nested inside. They're drawn
  // before long tasks so an overlapping long task (often the same handler) doesn't break nesting.
  const inp = tl.input!;
  const kp = tl.keyphase!;
  const probed: { t: number; ph: KeyPhases }[] = [];
  const tasks: [number, number][] = [];
  for (const i of rows(inp, p.from, p.to)) {
    const t = inp.t![i]!;
    const ph = kp.t?.length ? keyPhasesAt(kp, t) : null;
    if (ph) probed.push({ t, ph });
  }
  for (const { t, ph } of probed) {
    if (ph.handlers === null) continue;
    ev.push({ name: 'RunTask', cat: TL, ph: 'X', ts: us(t), dur: us(ph.handlers), pid: RENDERER, tid: MAIN, args: {} });
    ev.push({ name: 'EventDispatch', cat: 'devtools.timeline', ph: 'X', ts: us(t), dur: us(ph.handlers), pid: RENDERER, tid: MAIN, args: { data: { type: 'keydown', frame: FRAME } } });
    tasks.push([t, ph.handlers]);
    const frame = frameSpans(t, ph);
    if (!frame) continue;
    ev.push({ name: 'RunTask', cat: TL, ph: 'X', ts: us(frame.start), dur: us(frame.end - frame.start), pid: RENDERER, tid: MAIN, args: {} });
    for (const s of frame.spans) ev.push({ ...s.event, cat: TL, ph: 'X', ts: us(s.start), dur: us(s.dur), pid: RENDERER, tid: MAIN });
    tasks.push([frame.start, frame.end - frame.start]);
  }

  const lt = tl.longtask!;
  const overlaps = (start: number, end: number) => tasks.some(([s, d]) => s < end && s + d > start);
  const longTasks: [number, number][] = [];
  for (const i of rows(lt, p.from, p.to)) {
    const t = lt.t![i]!;
    const d = lt.durMs![i]!;
    if (!overlaps(t, t + d)) longTasks.push([t, d]);
  }
  tasks.push(...longTasks);
  const lag = tl.lag!;
  for (const i of rows(lag, p.from, p.to + 1000)) {
    const end = lag.t![i]!;
    const ms = lag.lagMs![i]!;
    const start = end - ms;
    if (ms >= LAG_TASK_MS && !overlaps(start, end)) {
      longTasks.push([start, ms]);
      tasks.push([start, ms]);
    }
  }
  for (const [t, d] of longTasks) ev.push({ name: 'RunTask', cat: TL, ph: 'X', ts: us(t), dur: us(d), pid: RENDERER, tid: MAIN, args: {} });

  rows(inp, p.from, p.to).forEach((i, k) => {
    const t = inp.t![i]!;
    const toFrame = inp.toFrameMs![i]!;
    if (toFrame < 0) return;
    const id = `0x${(k + 1).toString(16)}`;
    const ph = probed.find((x) => x.t === t)?.ph;
    const frame = ph ? frameSpans(t, ph) : null;
    // Without a probe, teleport only knows key → next frame, so the panel reads it all as presentation delay.
    const queued = t - (ph?.inputDelay ?? 0);
    const handled = t + (ph?.handlers ?? 0);
    const end = frame ? frame.end : t + toFrame;
    const data = { type: 'keydown', interactionId: 1000 + k, timeStamp: queued, processingStart: t, processingEnd: handled, duration: Math.max(1, Math.round(end - queued)), frame: FRAME, cancelable: true, nodeId: 0 };
    ev.push({ name: 'EventTiming', cat: 'devtools.timeline', ph: 'b', id, ts: us(queued), pid: RENDERER, tid: MAIN, args: { data, frame: FRAME } });
    ev.push({ name: 'EventTiming', cat: 'devtools.timeline', ph: 'e', id, ts: us(end), pid: RENDERER, tid: MAIN, args: {} });
  });

  const served = p.network.map((r) => ({ ...r, agentStart: r.start + p.offsetMs })).filter((r) => r.agentStart >= p.from && r.agentStart < p.to);
  served.forEach((r, k) =>
    request(ev, `teleport.${k}`, { start: r.agentStart, ttfbMs: r.ttfb - r.start, durMs: r.end - r.start, url: r.url, type: r.type === 'XHR' ? 'XHR' : r.type, status: r.status, mime: r.mimeType, bytes: r.bytes, failed: !!r.failed }),
  );
  const res = tl.resource!;
  rows(res, p.from, p.to).forEach((i, k) => {
    const url = p.names[res.name![i]!] ?? `resource ${res.name![i]}`;
    const start = res.t![i]!;
    if (served.some((r) => r.url === url && Math.abs(r.agentStart - start) < DEDUPE_MS)) return;
    const kind = RESOURCE_KINDS[res.kind![i]!] ?? 'other';
    const ttfb = res.ttfbMs![i]!;
    request(ev, `device.${k}`, { start, ttfbMs: ttfb >= 0 ? ttfb : null, durMs: res.durMs![i]!, url, type: RESOURCE_TYPE[kind] ?? 'Other', status: 200, mime: '', bytes: res.bytes![i]!, failed: false });
  });
  return ev;
}
