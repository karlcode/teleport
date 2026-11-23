import type { Frame } from './decode.js';
import { STREAMS } from './generated/schema.js';

/**
 * Where each stream of one page stands: the position of the next record expected. A frame resent
 * after a reconnect repeats positions the server already took; admit() keeps only new records and
 * counts positions that never arrived. Frames without positions (version 2) pass through whole.
 */
export class Positions {
  private next = new Map<number, number>();
  private gaps = new Map<number, number>();

  admit(f: Frame): Frame {
    let trimmed = false;
    const streams = f.streams.map((s) => {
      if (s.first === null) return s;
      const have = this.next.get(s.id);
      const from = have ?? s.first;
      if (s.first > from) this.gaps.set(s.id, (this.gaps.get(s.id) ?? 0) + s.first - from);
      this.next.set(s.id, Math.max(from, s.first + s.count));
      const skip = Math.min(s.count, Math.max(0, from - s.first));
      if (!skip) return s;
      trimmed = true;
      const columns: Record<string, Float64Array> = {};
      for (const k in s.columns) columns[k] = s.columns[k]!.subarray(skip);
      return { ...s, first: s.first + skip, count: s.count - skip, columns };
    });
    return trimmed ? { ...f, streams } : f;
  }

  /** The next position expected on this stream. */
  at(id: number): number | undefined {
    return this.next.get(id);
  }

  /** Positions that never arrived on this stream. */
  missed(id: number): number {
    return this.gaps.get(id) ?? 0;
  }

  /** The next position of every stream, in schema order, or null before any frame with positions.
   *  A stream the agent has sent nothing of yet (it leaves empty streams out of a frame) stands at 0. */
  list(): number[] | null {
    if (!this.next.size) return null;
    return STREAMS.map((s) => this.next.get(s.id) ?? 0);
  }
}
