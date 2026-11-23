// `try`: one thing flipped on the device, measured both ways, with nothing to write. Each toggle is a
// trial spec made here: the same rail of tiles moved with the remote's keys, once without the thing
// and once with it, so the report's differences are the cost of that one thing on this engine.
// `try css <rules>` does the same on the app itself: its page as it is against its page with the
// rules added. Everything in a spec's html and setup runs on the device, so it is ES5. These are
// things to measure, not results: nothing here says which way a device will go.

export interface Toggle {
  name: string;
  /** A few words: what is flipped. */
  brief: string;
  /** The two variants' names, the baseline first. */
  off: string;
  on: string;
  /** CSS each variant adds to the rail. */
  offCss?: string;
  onCss?: string;
  /** How the rail moves, per variant: its `left`, or a transform (the default). */
  offMove?: 'left';
  /** Extra HTML the second variant adds. */
  onHtml?: string;
  /** ES5 read once on the device: the facts that say why. */
  checks?: Record<string, string>;
}

const supports = (prop: string, value: string) => `typeof CSS!=='undefined'&&CSS.supports?CSS.supports(${JSON.stringify(prop)},${JSON.stringify(value)}):null`;

export const TOGGLES: Toggle[] = [
  { name: 'transform', brief: 'move with transform, or with left', off: 'left', on: 'transform', offMove: 'left' },
  { name: 'will-change', brief: 'will-change on what moves', off: 'none', on: 'will-change', onCss: '#rail{will-change:transform}', checks: { willChange: supports('will-change', 'transform') } },
  { name: 'layers', brief: 'a layer for every tile', off: 'one layer', on: 'a layer each', onCss: '.tile{-webkit-transform:translateZ(0);transform:translateZ(0)}' },
  { name: 'shadow', brief: 'box-shadow on every tile', off: 'no shadow', on: 'box-shadow', onCss: '.tile{box-shadow:0 12px 40px rgba(0,0,0,.6)}' },
  { name: 'radius', brief: 'rounded, clipped corners', off: 'square', on: 'rounded', onCss: '.tile{border-radius:24px;overflow:hidden}' },
  { name: 'gradient', brief: 'gradient backgrounds', off: 'solid', on: 'gradient', onCss: '.tile{background:-webkit-linear-gradient(315deg,#456,#123);background:linear-gradient(135deg,#456,#123)}' },
  { name: 'blur', brief: 'a blur filter on the tiles', off: 'no filter', on: 'blur', onCss: '.tile{-webkit-filter:blur(2px);filter:blur(2px)}', checks: { filter: supports('filter', 'blur(2px)'), webkitFilter: supports('-webkit-filter', 'blur(2px)') } },
  { name: 'opacity', brief: 'see-through tiles', off: 'opaque', on: 'opacity', onCss: '.tile{opacity:.6}.focused{opacity:1}' },
  { name: 'scale', brief: 'focus by scale, or by outline', off: 'outline', on: 'scale', offCss: '.focused{outline:6px solid #fff}', onCss: '.tile{-webkit-transition:-webkit-transform .2s;transition:transform .2s}.focused{-webkit-transform:scale(1.1);transform:scale(1.1)}' },
  { name: 'dom', brief: '2,000 more nodes in the page', off: '40 nodes', on: '2,040 nodes', onHtml: `<div style="position:absolute;top:400px;left:0;width:1px;height:1px;overflow:hidden">${'<span><b>x</b></span>'.repeat(1000)}</div>` },
];

/** What `try` takes of your own, after the toggles. */
export const OWN = [
  { name: 'css <rules>', brief: 'your app, with and without these rules' },
  { name: 'js <es5>', brief: 'your code on a blank page, timed' },
  { name: 'html <markup>', brief: 'your markup against the rail, keys pressed' },
  { name: 'codec [name]', brief: 'play real clips: hevc, av1, drm, switch' },
];

/** Words that mean the media clips (verify.ts), which `try` hands to verify. */
export const CODEC_WORDS = /^(codecs?|video|audio|media|h\.?264|avc|hevc|h\.?265|vp9|av1|aac|e?-?ac-?3|opus|drm|clearkey|switch)$/i;

const KEYS = ['right', 'right', 'right', 'right', 'left', 'left', 'left', 'left'];
const TILES = Array.from({ length: 40 }, (_, i) => `<div class="tile">${i + 1}</div>`).join('');
const BASE = `<style>body{margin:0;background:#000;overflow:hidden}#rail{position:relative;left:0;display:-webkit-flex;display:flex;padding:40px}.tile{-webkit-flex:0 0 200px;flex:0 0 200px;margin-right:16px;height:300px;background:#222;color:#fff;font:32px sans-serif;line-height:300px;text-align:center}.focused{background:#555}</style><div id="rail">${TILES}</div>`;
const style = (css: string) => (css ? `var s=document.createElement('style');s.textContent=${JSON.stringify(css)};document.head.appendChild(s);` : '');
/** The rail follows the focused tile, as apps for these devices move theirs: a class on keydown, and the rail slid over 200 ms. */
// Both sides add one style element, so the page differs by the toggle alone.
const rail = (move: 'left' | 'transform', css: string) =>
  `${style((move === 'left' ? '#rail{-webkit-transition:left .2s;transition:left .2s}' : '#rail{-webkit-transition:-webkit-transform .2s;transition:transform .2s}') + css)}
var tiles=document.getElementsByClassName('tile'),el=document.getElementById('rail'),at=0;tiles[0].className='tile focused';
document.addEventListener('keydown',function(e){var k=e.keyCode;if(k!==37&&k!==39)return;tiles[at].className='tile';at=Math.max(0,Math.min(tiles.length-1,at+(k===39?1:-1)));tiles[at].className='tile focused';var x=-at*216;${move === 'left' ? "el.style.left=x+'px'" : "el.style.webkitTransform=el.style.transform='translateX('+x+'px)'"}});`;

export interface TryOptions {
  runs?: number;
  keys?: string[];
}

/** The trial spec for a toggle. */
export function toggleSpec(t: Toggle, o: TryOptions = {}): Record<string, unknown> {
  return {
    name: t.name,
    runs: o.runs ?? 5,
    keys: o.keys?.length ? o.keys : KEYS,
    keyGapMs: 300,
    html: BASE,
    variants: [
      { name: t.off, setup: rail(t.offMove ?? 'transform', t.offCss ?? '') },
      { name: t.on, setup: rail('transform', t.onCss ?? ''), html: t.onHtml ?? '' },
    ],
    checks: t.checks ?? {},
  };
}

const add = (css: string) => `var s=document.createElement('style');s.textContent=${JSON.stringify(css)};document.head.appendChild(s);T.cleanup(function(){if(s.parentNode)s.parentNode.removeChild(s)});`;

/** The app's own page as it is, against the same page with these rules added; the rules are taken out after each run. */
export function cssSpec(rules: string, o: TryOptions = {}): Record<string, unknown> {
  return {
    name: 'css',
    where: 'page',
    runs: o.runs ?? 5,
    keys: o.keys?.length ? o.keys : KEYS,
    keyGapMs: 300,
    // Both sides add a style element, the first an empty one, so the page differs by the rules alone.
    variants: [
      { name: 'app as it is', setup: add('') },
      { name: 'with the css', setup: add(rules) },
    ],
  };
}

/**
 * Your own code on a blank page, without it and with it: what it costs on this engine, with nothing of
 * the app in the way. It runs once per run as the variant's setup, in a fresh frame, so nothing is left
 * over between runs. ES5 only.
 */
export function jsSpec(code: string, o: TryOptions = {}): Record<string, unknown> {
  return {
    name: 'js',
    runs: o.runs ?? 5,
    keys: o.keys ?? [],
    observeMs: 1000,
    variants: [
      { name: 'blank page', setup: '' },
      { name: 'with your js', setup: code },
    ],
  };
}

/** Your own markup on a blank page against the rail of tiles, the remote's keys pressed on both: what drawing and moving it costs. */
export function htmlSpec(html: string, o: TryOptions = {}): Record<string, unknown> {
  return {
    name: 'html',
    runs: o.runs ?? 5,
    keys: o.keys?.length ? o.keys : KEYS,
    keyGapMs: 300,
    variants: [
      { name: 'the rail', html: BASE, setup: rail('transform', '') },
      { name: 'your html', html },
    ],
  };
}

export type Tried = { list: { name: string; brief: string }[] } | { verify: string[] } | { spec: Record<string, unknown> };

/** What `try <words>` means: the list, the media clips, or a trial spec. Throws for a word it doesn't know, with the nearest. */
export function tried(words: string[], o: TryOptions = {}): Tried {
  const [first = '', ...rest] = words;
  if (!first) return { list: [...TOGGLES.map((t) => ({ name: t.name, brief: t.brief })), ...OWN] };
  if (first.toLowerCase() === 'css') {
    if (!rest.length) throw new Error('try css needs the rules, such as: try css "* { box-shadow: none !important }"');
    return { spec: cssSpec(rest.join(' '), o) };
  }
  if (first.toLowerCase() === 'js') {
    if (!rest.length) throw new Error('try js needs ES5 to run, such as: try js "for(var i=0,a=[];i<1e5;i++)a.push({i:i})"');
    return { spec: jsSpec(rest.join(' '), o) };
  }
  if (first.toLowerCase() === 'html') {
    if (!rest.length) throw new Error('try html needs markup, such as: try html "<div style=\'box-shadow:0 0 40px #000\'>tile</div>"');
    return { spec: htmlSpec(rest.join(' '), o) };
  }
  if (CODEC_WORDS.test(first)) return { verify: /^(codecs?|video|audio|media)$/i.test(first) ? rest : words };
  const t = TOGGLES.find((x) => x.name === first.toLowerCase());
  if (!t) throw new Error(`nothing to try called ${first}: ${TOGGLES.map((x) => x.name).join(', ')}, ${OWN.map((x) => x.name).join(', ')}`);
  if (rest.length) throw new Error(`try ${t.name} takes no word "${rest[0]}"`);
  return { spec: toggleSpec(t, o) };
}
