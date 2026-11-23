// CDP messages the server writes itself, from data the laptop already has.
import type { NetEntry } from './netlog.js';

const NO = -1;

/** The Network events for one request the server served, on the agent's clock (seconds). */
export function networkEvents(e: NetEntry, documentURL: string, agentMs: (serverMs: number) => number): string[] {
  const sec = (ms: number) => agentMs(ms) / 1000;
  const ttfbMs = e.ttfb - e.start;
  const base = { requestId: e.id, loaderId: 'teleport', frameId: 'main', type: e.type };
  const out: { method: string; params: object }[] = [
    {
      method: 'Network.requestWillBeSent',
      params: {
        ...base,
        documentURL,
        request: { url: e.url, method: e.method, headers: e.requestHeaders, initialPriority: 'High', referrerPolicy: 'strict-origin-when-cross-origin' },
        timestamp: sec(e.start),
        wallTime: e.start / 1000,
        initiator: { type: 'other' },
      },
    },
  ];
  if (e.failed && e.status === 0) {
    out.push({ method: 'Network.loadingFailed', params: { ...base, timestamp: sec(e.end), errorText: e.failed, canceled: true } });
    return out.map((m) => JSON.stringify(m));
  }
  out.push({
    method: 'Network.responseReceived',
    params: {
      ...base,
      timestamp: sec(e.ttfb),
      response: {
        url: e.url,
        status: e.status,
        statusText: e.statusText,
        headers: e.responseHeaders,
        mimeType: e.mimeType,
        connectionReused: false,
        connectionId: 0,
        encodedDataLength: e.bytes,
        securityState: 'unknown',
        fromDiskCache: false,
        timing: {
          requestTime: sec(e.start),
          proxyStart: NO, proxyEnd: NO, dnsStart: NO, dnsEnd: NO, connectStart: NO, connectEnd: NO, sslStart: NO, sslEnd: NO,
          workerStart: NO, workerReady: NO, workerFetchStart: NO, workerRespondWithSettled: NO,
          sendStart: 0, sendEnd: 0, pushStart: 0, pushEnd: 0,
          receiveHeadersStart: ttfbMs, receiveHeadersEnd: ttfbMs,
        },
      },
    },
  });
  out.push({ method: 'Network.loadingFinished', params: { requestId: e.id, timestamp: sec(e.end), encodedDataLength: e.bytes } });
  return out.map((m) => JSON.stringify(m));
}
