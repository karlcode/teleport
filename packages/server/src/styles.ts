// What the device's engine drops from the app's style sheets: selectors it can't parse (the whole
// rule goes) and declarations it doesn't know. DevTools on the device can't show these, because the
// engine never kept them. The work is split so the device does almost none of it:
//   1. the device names its sheets (one small answer);
//   2. the laptop reads the sheets itself, from the same addresses, and takes them apart here;
//   3. the device is asked only about each distinct selector and declaration, a few hundred at a
//      time so no question holds its main thread for long, and answers with the numbers of the ones
//      it refuses. The engine's own parser is the judge: querySelector for a selector, CSS.supports
//      (or a style it is set on, where there is no CSS.supports) for a declaration.
// What is found is named by file and line from the laptop's copy.

export interface SheetRef {
  /** Where the sheet came from; '' for a <style> element. */
  href: string;
  /** A <style> element's text, as the device read it. */
  text: string | null;
  /** Style rules the engine kept, or -1 when it won't say (another origin's sheet). */
  kept: number;
}

export interface Decl {
  prop: string;
  value: string;
  line: number;
}

export interface Rule {
  selectors: string[];
  line: number;
  decls: Decl[];
}

export interface Dropped {
  /** The selector, or `property: value`. */
  text: string;
  /** Where it first appears, as `file:line`. */
  at: string;
  /** How many times the sheets use it. */
  uses: number;
}

export interface StylesReport {
  sheets: number;
  rules: number;
  declarations: number;
  /** Sheets the laptop could not read, with why. */
  unread: { href: string; why: string }[];
  selectors: Dropped[];
  properties: Dropped[];
  /** Whether the engine has CSS.supports; without it a declaration is judged by setting it on a style. */
  supports: boolean;
  /** Questions the device was asked, and its own time answering them, ms. */
  questions: number;
  ms: number;
}

const INLINE_MAX = 200_000;
/** Selectors or declarations per question. */
const CHUNK = 400;
const MAX_ITEMS = 40_000;

/** Names the page's sheets: [href, a <style>'s text or 0, style rules kept or -1], three values a sheet. */
export const SHEETS_SCRIPT =
  '(function(){var out=[],l=document.styleSheets,i,s,n,o;function count(r){var c=0,j;for(j=0;j<r.length;j++){if(r[j].type===1)c++;else if(r[j].cssRules)c+=count(r[j].cssRules)}return c}' +
  'for(i=0;i<l.length;i++){s=l[i];n=-1;try{n=count(s.cssRules||s.rules)}catch(e){}o=s.ownerNode;' +
  `out.push(s.href||"",!s.href&&o&&typeof o.textContent==="string"&&o.textContent.length<=${INLINE_MAX}?o.textContent:0,n)}return out})()`;

export function sheetRefs(v: unknown): SheetRef[] {
  const a = Array.isArray(v) ? v : [];
  const out: SheetRef[] = [];
  for (let i = 0; i + 2 < a.length; i += 3) out.push({ href: typeof a[i] === 'string' ? a[i] : '', text: typeof a[i + 1] === 'string' ? a[i + 1] : null, kept: typeof a[i + 2] === 'number' ? a[i + 2] : -1 });
  return out;
}

/** Asks the engine about each selector and each (property, value); answers the refused ones: a
 *  selector's index, or -1 minus a declaration's. The last two values say whether CSS.supports
 *  exists and how long the device took. */
export function checkScript(selectors: string[], decls: string[]): string {
  return (
    `(function(S,D){var t=Date.now(),bad=[],i,ok,st=document.createElement("div").style,has=!!(window.CSS&&CSS.supports);` +
    'for(i=0;i<S.length;i++){try{document.querySelector(S[i])}catch(e){bad.push(i)}}' +
    'for(i=0;i<D.length;i+=2){ok=false;try{if(has)ok=CSS.supports(D[i],D[i+1]);else{st.cssText="";st.cssText=D[i]+":"+D[i+1];ok=st.length>0}}catch(e){}if(!ok)bad.push(-1-i/2)}' +
    `bad.push(has?1:0,Date.now()-t);return bad})(${js(selectors)},${js(decls)})`
  );
}

/** JSON that is also ES5 source: the two line separators JSON allows raw in a string, ES5 does not. */
const js = (v: unknown) => JSON.stringify(v).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

/** A selector list at its top-level commas. */
function splitList(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  let quote = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    else if (ch === ',' && depth === 0) {
      out.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(text.slice(start).trim());
  return out.filter(Boolean);
}

/** At-rules whose block holds rules of its own. Any other at-rule's block is left alone. */
const NESTING = /^@(media|supports|document|layer|container|scope|starting-style)\b/i;

/**
 * The style rules of a sheet, with the line each selector and declaration starts on. Comments,
 * strings and url() are stepped over, so a brace or semicolon inside one ends nothing. Keyframes,
 * font faces and the like are skipped: what is in them is not a selector, and the engines this is
 * for take or leave those blocks whole.
 */
export function parseCss(css: string): Rule[] {
  const rules: Rule[] = [];
  let i = 0;
  let line = 1;
  const n = css.length;

  /** Reads to one of `stops` at depth 0, returning the text without comments. */
  function until(stops: string): string {
    let out = '';
    let depth = 0;
    while (i < n) {
      const ch = css[i]!;
      if (ch === '/' && css[i + 1] === '*') {
        const end = css.indexOf('*/', i + 2);
        const stop = end < 0 ? n : end + 2;
        for (let k = i; k < stop; k++) if (css[k] === '\n') line++;
        i = stop;
        continue;
      }
      if (ch === '"' || ch === "'") {
        const start = i++;
        while (i < n && css[i] !== ch) {
          if (css[i] === '\\') i++;
          if (css[i] === '\n') line++;
          i++;
        }
        i++;
        out += css.slice(start, i);
        continue;
      }
      if (depth === 0 && stops.includes(ch)) return out;
      if (ch === '(' || ch === '[') depth++;
      else if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1);
      else if (ch === '\n') line++;
      out += ch;
      i++;
    }
    return out;
  }

  function skipBlock() {
    let depth = 1;
    while (i < n && depth > 0) {
      until('{}');
      if (css[i] === '{') depth++;
      else if (css[i] === '}') depth--;
      i++;
    }
  }

  function declarations(): Decl[] {
    const decls: Decl[] = [];
    while (i < n && css[i] !== '}') {
      while (i < n && /\s/.test(css[i]!)) {
        if (css[i] === '\n') line++;
        i++;
      }
      const at = line;
      const text = until(';}{');
      if (css[i] === '{') {
        // A nested rule (CSS nesting): not for these engines, and not read here.
        i++;
        skipBlock();
        continue;
      }
      if (css[i] === ';') i++;
      const colon = text.indexOf(':');
      if (colon < 1) continue;
      const prop = text.slice(0, colon).trim();
      const value = text.slice(colon + 1).replace(/!\s*important\s*$/i, '').trim();
      if (prop && value) decls.push({ prop, value, line: at });
    }
    i++;
    return decls;
  }

  function block(top: boolean) {
    while (i < n) {
      while (i < n && /\s/.test(css[i]!)) {
        if (css[i] === '\n') line++;
        i++;
      }
      if (i >= n) return;
      if (css[i] === '}') {
        i++;
        if (!top) return;
        continue;
      }
      const at = line;
      const prelude = until('{;}').trim();
      if (css[i] !== '{') {
        // `@import ...;` and the like, or stray text.
        if (css[i] === ';') i++;
        continue;
      }
      i++;
      if (prelude.startsWith('@')) {
        if (NESTING.test(prelude)) block(false);
        else skipBlock();
      } else if (prelude) rules.push({ selectors: splitList(prelude), line: at, decls: declarations() });
      else skipBlock();
    }
  }

  block(true);
  return rules;
}

export interface Source {
  /** As the report names it: the file's name, or `<style>` and its number. */
  name: string;
  rules: Rule[];
}

/** Each distinct selector and declaration of the sources, with where it is first and how often. */
export function distinct(sources: Source[]) {
  const selectors = new Map<string, Dropped>();
  const decls = new Map<string, Dropped & { prop: string; value: string }>();
  let rules = 0;
  let declarations = 0;
  for (const s of sources) {
    for (const r of s.rules) {
      rules++;
      for (const sel of r.selectors) {
        const had = selectors.get(sel);
        if (had) had.uses++;
        else if (selectors.size < MAX_ITEMS) selectors.set(sel, { text: sel, at: `${s.name}:${r.line}`, uses: 1 });
      }
      for (const d of r.decls) {
        declarations++;
        const key = d.prop.toLowerCase() + ': ' + d.value;
        const had = decls.get(key);
        if (had) had.uses++;
        else if (decls.size < MAX_ITEMS) decls.set(key, { text: key, at: `${s.name}:${d.line}`, uses: 1, prop: d.prop, value: d.value });
      }
    }
  }
  return { selectors: [...selectors.values()], decls: [...decls.values()], rules, declarations };
}

export function sourceName(href: string, index: number): string {
  if (!href) return `<style ${index + 1}>`;
  try {
    return new URL(href).pathname.split('/').pop() || href;
  } catch {
    return href;
  }
}

/**
 * The whole check. `ask` runs ES5 on the device; `read` fetches a sheet's text on the laptop.
 */
export async function droppedStyles(ask: (script: string) => Promise<unknown>, read: (href: string) => Promise<string>): Promise<StylesReport> {
  const refs = sheetRefs(await ask(SHEETS_SCRIPT));
  const unread: StylesReport['unread'] = [];
  const sources: Source[] = [];
  await Promise.all(
    refs.map(async (ref, index) => {
      let text = ref.text;
      if (text === null && ref.href) {
        try {
          text = await read(ref.href);
        } catch (e) {
          unread.push({ href: ref.href, why: (e as Error).message });
        }
      } else if (text === null) unread.push({ href: '<style>', why: `longer than ${INLINE_MAX / 1000} KB` });
      if (text !== null) sources[index] = { name: sourceName(ref.href, index), rules: parseCss(text) };
    }),
  );
  const all = distinct(sources.filter(Boolean));
  const report: StylesReport = { sheets: refs.length, rules: all.rules, declarations: all.declarations, unread, selectors: [], properties: [], supports: false, questions: 1, ms: 0 };
  const flat = all.decls.flatMap((d) => [d.prop, d.value]);
  for (let s = 0, d = 0; s < all.selectors.length || d < all.decls.length; s += CHUNK, d += CHUNK) {
    const sels = all.selectors.slice(s, s + CHUNK);
    const bad = (await ask(checkScript(sels.map((x) => x.text), flat.slice(d * 2, (d + CHUNK) * 2)))) as number[];
    if (!Array.isArray(bad) || bad.length < 2) throw new Error("styles: the device's answer made no sense");
    report.questions++;
    report.ms += Number(bad[bad.length - 1]) || 0;
    report.supports = bad[bad.length - 2] === 1;
    for (const x of bad.slice(0, -2)) {
      const hit = x >= 0 ? all.selectors[s + x] : all.decls[d + (-1 - x)];
      if (!hit) throw new Error("styles: the device's answer made no sense");
      (x >= 0 ? report.selectors : report.properties).push({ text: hit.text, at: hit.at, uses: hit.uses });
    }
  }
  // The most used first; among equals, in the order the sheets have them.
  report.selectors.sort((a, b) => b.uses - a.uses);
  report.properties.sort((a, b) => b.uses - a.uses);
  return report;
}
