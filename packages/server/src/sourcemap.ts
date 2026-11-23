// Where a place in a built file came from. An app on a device runs a bundle: transpiled down to
// what the engine takes, often minified, so "app.js:1:48213" names nothing a person wrote. The
// build's source map says which file and line that was, and usually holds the file's text. Reading
// it is the laptop's work and costs the device nothing: the laptop already fetches the script to
// show the code around an error, and the map is one more request to the same place.
//
// Source map v3, the form every bundler writes: one `mappings` string, a line of the built file
// between each `;`, a segment between each `,`, each segment up to five numbers as base64 VLQ, every
// one but the built column carried on from the segment before. Indexed maps (`sections`) are not
// read: the answer is then "no map", never a wrong line.

/** A place in a file a person wrote. Line and column count from 1. */
export interface Original {
  /** The file, as the map names it: `../src/rail.ts`, `webpack://app/./src/rail.ts`. */
  source: string;
  line: number;
  col: number;
  /** That line of the file, when the map carries the file's text; null when it only names it. */
  text: string | null;
}

/** The address a script gives for its source map: its last `sourceMappingURL` comment. Null with none. */
export function mapUrlOf(script: string): string | null {
  // Only the end is searched: the comment is the file's last line, and a bundle is megabytes.
  const tail = script.slice(-4096);
  let url: string | null = null;
  for (const m of tail.matchAll(/\/\/[#@] ?sourceMappingURL=(\S+)/g)) url = m[1]!;
  return url;
}

/** The map an inline `data:` address holds, as text; null when the address is not one. */
export function inlineMap(url: string): string | null {
  const m = /^data:application\/json[^,]*?(;base64)?,(.*)$/s.exec(url);
  if (!m) return null;
  try {
    return m[1] ? Buffer.from(m[2]!, 'base64').toString('utf8') : decodeURIComponent(m[2]!);
  } catch {
    return null;
  }
}

const DIGIT = new Int8Array(128).fill(-1);
for (let i = 0; i < 64; i++) DIGIT['ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'.charCodeAt(i)] = i;

/**
 * The place in the sources that line and column of the built file came from; both count from 1, as
 * an engine reports them. Null when the map has nothing for that place or isn't one this reads.
 */
export function originalOf(map: unknown, line: number, col: number): Original | null {
  const m = map as { version?: unknown; mappings?: unknown; sources?: unknown; sourcesContent?: unknown; sourceRoot?: unknown } | null;
  if (!m || typeof m !== 'object' || typeof m.mappings !== 'string' || !Array.isArray(m.sources) || line < 1 || col < 1) return null;
  const s = m.mappings;
  // What a segment carries on from the one before: its source, and that source's line and column.
  let source = 0;
  let srcLine = 0;
  let srcCol = 0;
  let found: [number, number, number] | null = null;
  let at = 0;
  lines: for (let l = 1; l <= line && at <= s.length; l++) {
    let genCol = 0;
    // One line of the built file: segments in order of column, so the last one at or before the
    // column asked for is the one that covers it.
    while (at < s.length && s.charCodeAt(at) !== 59 /* ; */) {
      const f: number[] = [];
      while (at < s.length && s.charCodeAt(at) !== 44 /* , */ && s.charCodeAt(at) !== 59) {
        let value = 0;
        let shift = 0;
        let digit: number;
        do {
          digit = DIGIT[s.charCodeAt(at++)] ?? -1;
          if (digit < 0) return null;
          value += (digit & 31) * 2 ** shift;
          shift += 5;
        } while (digit & 32);
        f.push(value % 2 ? -(value - 1) / 2 : value / 2);
      }
      if (s.charCodeAt(at) === 44) at++;
      if (!f.length) continue;
      genCol += f[0]!;
      // Past the column on its line: the segment before it was the answer. A minified bundle is one
      // line of a million segments, and the rest need not be read.
      if (l === line && genCol > col - 1) break lines;
      // A segment of one number says "nothing a person wrote is here"; it moves no source position.
      if (f.length >= 4) {
        source += f[1]!;
        srcLine += f[2]!;
        srcCol += f[3]!;
      }
      if (l === line) found = f.length >= 4 ? [source, srcLine, srcCol] : null;
    }
    at++;
  }
  if (!found) return null;
  const name = m.sources[found[0]];
  if (typeof name !== 'string') return null;
  const root = typeof m.sourceRoot === 'string' && m.sourceRoot ? m.sourceRoot.replace(/\/?$/, '/') : '';
  const content = Array.isArray(m.sourcesContent) ? m.sourcesContent[found[0]] : null;
  const text = typeof content === 'string' ? (content.split('\n')[found[1]] ?? null) : null;
  return { source: root + name, line: found[1] + 1, col: found[2] + 1, text: text === null ? null : text.replace(/\r$/, '') };
}
