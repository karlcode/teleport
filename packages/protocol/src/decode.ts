import { HEADER_BYTES, MAGIC, STREAMS, STREAM_HEADER_BYTES, VERSION, type FieldType, type StreamDef } from './generated/schema.js';

export class DecodeError extends Error {
  override name = 'DecodeError';
}

export interface DecodedStream {
  id: number;
  name: string;
  count: number;
  /** Cumulative records the agent lost to ring overwrite before sending. */
  dropped: number;
  /** Position of the first record in its stream, or null from an agent older than version 3. */
  first: number | null;
  /** Columnar values; `t` is absolute (baseTime + offset) in the agent's clock, ms. */
  columns: Record<string, Float64Array>;
}

export interface Frame {
  version: number;
  seq: number;
  baseTime: number;
  streams: DecodedStream[];
}

const BYTES: Record<FieldType, number> = { 1: 1, 2: 2, 3: 4, 4: 4, 5: 8 };
const byId = new Map<number, StreamDef>(STREAMS.map((s) => [s.id, s]));

function read(v: DataView, o: number, type: FieldType): number {
  switch (type) {
    case 1: return v.getUint8(o);
    case 2: return v.getUint16(o, true);
    case 3: return v.getUint32(o, true);
    case 4: return v.getFloat32(o, true);
    case 5: return v.getFloat64(o, true);
  }
}

export function decodeFrame(data: ArrayBuffer | ArrayBufferView): Frame {
  const v = data instanceof ArrayBuffer
    ? new DataView(data)
    : new DataView(data.buffer, data.byteOffset, data.byteLength);
  const need = (o: number, n: number) => {
    if (o + n > v.byteLength) throw new DecodeError(`truncated frame: need ${o + n} bytes, have ${v.byteLength}`);
  };

  need(0, HEADER_BYTES);
  if (v.getUint16(0, true) !== MAGIC) throw new DecodeError('bad magic');
  const version = v.getUint8(2);
  // Version 2 is version 3 without stream positions, from an agent built into an app earlier.
  if (version !== VERSION && version !== 2) throw new DecodeError(`unsupported version ${version}`);
  const streamHeader = version === 2 ? 8 : STREAM_HEADER_BYTES;
  const streamCount = v.getUint8(3);
  const seq = v.getUint32(4, true);
  const baseTime = v.getFloat64(8, true);

  let o = HEADER_BYTES;
  const streams: DecodedStream[] = [];
  for (let k = 0; k < streamCount; k++) {
    need(o, streamHeader);
    const id = v.getUint8(o);
    const def = byId.get(id);
    if (!def) throw new DecodeError(`unknown stream id ${id}`);
    const count = v.getUint16(o + 2, true);
    const dropped = v.getUint32(o + 4, true);
    const first = version === 2 ? null : v.getUint32(o + 8, true);
    o += streamHeader;
    need(o, count * def.recordBytes);

    const columns: Record<string, Float64Array> = {};
    for (const f of def.fields) columns[f] = new Float64Array(count);
    for (let j = 0; j < count; j++) {
      for (let c = 0; c < def.fields.length; c++) {
        const type = def.types[c]!;
        const x = read(v, o, type);
        columns[def.fields[c]!]![j] = c === 0 ? baseTime + x : x;
        o += BYTES[type];
      }
    }
    streams.push({ id, name: def.name, count, dropped, first, columns });
  }
  if (o !== v.byteLength) throw new DecodeError(`trailing bytes: parsed ${o}, have ${v.byteLength}`);
  return { version, seq, baseTime, streams };
}
