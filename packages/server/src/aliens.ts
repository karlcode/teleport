// The crew: three small pixel aliens, the cast of the clips verify and try play. Each clip opens as a
// silent film (the crew trudging to a portal in grainy, flickering black and white), then the portal
// floods the screen with colour and the rest is a disco: rainbow rays, a mirror ball, a floor that
// lights up on the beat, and the crew dancing in sunglasses. Frames are drawn here at a low resolution
// (192 by 108), as raw RGB, and ffmpeg scales them up with nearest neighbour, so every pixel stays a
// crisp square at 1080p and 2160p. Pure and deterministic: the same clip comes out the same on every
// laptop. Grain, rays and tiles change every frame, so an encoder has real detail to code.

/** The low resolution the scene is drawn at: a tenth of 1080p, a twentieth of 2160p. */
export const SCENE_W = 192;
export const SCENE_H = 108;

type RGB = readonly [number, number, number];

/** The palette: phosphor ink on near-black, and the accents tlpt draws with. */
const SPACE: RGB = [10, 12, 10];
const STAR: RGB = [214, 222, 178];
const STAR_DIM: RGB = [107, 111, 89];
const WHITE: RGB = [245, 248, 236];
const PUPIL: RGB = [20, 24, 30];
const MOUTH: RGB = [40, 30, 40];
const BLUSH: RGB = [250, 150, 170];
const PORTAL = [[63, 212, 192], [122, 170, 247], [180, 150, 240]] as const;

interface Alien {
  name: string;
  body: RGB;
  shade: RGB;
  glow: RGB;
  /** Two frames of a step, the same size: '.' is space; B body, D shade, G glow, W white, P pupil, M mouth, C blush. */
  frames: [string[], string[]];
}

/** Blip: round, two eyes, one antenna with a light on top. */
const BLIP: Alien = {
  name: 'blip',
  body: [63, 212, 192],
  shade: [30, 130, 118],
  glow: [255, 236, 140],
  frames: [
    [
      '......G......',
      '......D......',
      '....BBBBB....',
      '..BBBBBBBBB..',
      '.BBWWBBBWWBB.',
      '.BBWPBBBWPBB.',
      '.BCBBBBBBBCB.',
      '.BBBBMMMBBBB.',
      '..BBBBBBBBB..',
      '...DD...DD...',
      '..DD.....DD..',
    ],
    [
      '.....G.......',
      '......D......',
      '....BBBBB....',
      '..BBBBBBBBB..',
      '.BBWWBBBWWBB.',
      '.BBPWBBBPWBB.',
      '.BCBBBBBBBCB.',
      '.BBBBMMMBBBB.',
      '..BBBBBBBBB..',
      '...DD...DD...',
      '....DD.DD....',
    ],
  ],
};

/** Oko: one big eye that looks about, two feelers, three feet. */
const OKO: Alien = {
  name: 'oko',
  body: [242, 173, 72],
  shade: [168, 108, 36],
  glow: [255, 236, 140],
  frames: [
    [
      '..G.......G..',
      '...D.....D...',
      '....DBBBD....',
      '..BBBBBBBBB..',
      '.BBBWWWWWBBB.',
      '.BBWWWPPWWBB.',
      '.BBWWWPPWWBB.',
      '.BCBWWWWWBCB.',
      '..BBBBMBBBB..',
      '..DD.DD.DD...',
      '.DD..D...DD..',
    ],
    [
      '...G......G..',
      '...D.....D...',
      '....DBBBD....',
      '..BBBBBBBBB..',
      '.BBBWWWWWBBB.',
      '.BBWWPPWWWBB.',
      '.BBWWPPWWWBB.',
      '.BCBWWWWWBCB.',
      '..BBBBMBBBB..',
      '...DD.DD.DD..',
      '..DD...D..DD.',
    ],
  ],
};

/** Tri: tall, three eyes, little fins for ears. */
const TRI: Alien = {
  name: 'tri',
  body: [180, 150, 240],
  shade: [110, 86, 170],
  glow: [255, 236, 140],
  frames: [
    [
      '.D.........D.',
      '.BD.......DB.',
      '..BBBBBBBBB..',
      '.BBWBBWBBWBB.',
      '.BBPBBPBBPBB.',
      '.BBBBBBBBBBB.',
      '.BCBBMMMBBCB.',
      '..BBBBBBBBB..',
      '..BBBBBBBBB..',
      '...BB...BB...',
      '..DD.....DD..',
    ],
    [
      'D...........D',
      '.BD.......DB.',
      '..BBBBBBBBB..',
      '.BBWBBWBBWBB.',
      '.BBPBBPBBPBB.',
      '.BBBBBBBBBBB.',
      '.BCBBMMMBBCB.',
      '..BBBBBBBBB..',
      '..BBBBBBBBB..',
      '...BB...BB...',
      '....DD.DD....',
    ],
  ],
};

export const CREW: readonly Alien[] = [BLIP, OKO, TRI];

/** A 3 by 5 pixel font for the clip's label: capitals, digits and a few marks. */
const FONT: Record<string, string> = {
  A: '010101111101101', B: '110101110101110', C: '011100100100011', D: '110101101101110', E: '111100110100111', F: '111100110100100',
  G: '011100101101011', H: '101101111101101', I: '111010010010111', J: '001001001101010', K: '101101110101101', L: '100100100100111',
  M: '101111111101101', N: '110101101101101', O: '010101101101010', P: '110101110100100', Q: '010101101110011', R: '110101110101101',
  S: '011100010001110', T: '111010010010010', U: '101101101101111', V: '101101101101010', W: '101101111111101', X: '101101010101101',
  Y: '101101010010010', Z: '111001010100111', '0': '010101101101010', '1': '010110010010111', '2': '110001010100111', '3': '110001010001110',
  '4': '101101111001001', '5': '111100110001110', '6': '011100110101010', '7': '111001010010010', '8': '010101010101010', '9': '010101011001110',
  '-': '000000111000000', '.': '000000000000010', ' ': '000000000000000', '>': '100010001010100', '/': '001001010100100',
};

/** A small deterministic generator, so the stars sit in the same places in every clip. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const STARS = (() => {
  const r = rng(7);
  return Array.from({ length: 70 }, () => ({ x: Math.floor(r() * SCENE_W), y: Math.floor(r() * (SCENE_H - 18)), phase: r() * Math.PI * 2, bright: r() > 0.75 }));
})();

/** One frame's pixels, and the ways to draw into them. */
class Canvas {
  readonly px: Buffer;
  constructor(
    readonly w: number,
    readonly h: number,
  ) {
    this.px = Buffer.alloc(w * h * 3);
  }
  set(x: number, y: number, c: RGB) {
    x = Math.round(x);
    y = Math.round(y);
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const i = (y * this.w + x) * 3;
    this.px[i] = c[0];
    this.px[i + 1] = c[1];
    this.px[i + 2] = c[2];
  }
  fill(c: RGB) {
    for (let i = 0; i < this.px.length; i += 3) {
      this.px[i] = c[0];
      this.px[i + 1] = c[1];
      this.px[i + 2] = c[2];
    }
  }
  text(s: string, x: number, y: number, c: RGB) {
    for (const ch of s.toUpperCase()) {
      const g = FONT[ch] ?? FONT[' ']!;
      for (let i = 0; i < 15; i++) if (g[i] === '1') this.set(x + (i % 3), y + Math.floor(i / 3), c);
      x += 4;
    }
  }
}

const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t].map(Math.round) as unknown as RGB;

/** Each sprite pixel is this many scene pixels a side. */
const PX = 2;

interface Pose {
  /** Width and height, as a share of the sprite's own; anchored at the middle of its feet. */
  sx?: number;
  sy?: number;
  /** Faces the other way. */
  flip?: boolean;
  /** Sunglasses: one black lens bar across the eyes, with a glint. */
  shades?: boolean;
  /** A black outline, to stand out on a busy ground. */
  outline?: boolean;
}

/** The sprite in sunglasses: each eye row black from its first eye pixel to its last ('S'), a glint ('g') top left. */
function inShades(sprite: string[]): string[] {
  let first = true;
  return sprite.map((r) => {
    const from = r.search(/[WP]/);
    if (from < 0) return r;
    const to = Math.max(r.lastIndexOf('W'), r.lastIndexOf('P'));
    const lens = 'S'.repeat(to - from + 1).split('');
    if (first) lens[0] = 'g';
    first = false;
    return r.slice(0, from) + lens.join('') + r.slice(to + 1);
  });
}

/** An alien's sprite at (x, y), its top left as it stands, posed: squashed, stretched, turned, in shades. */
function drawAlien(cv: Canvas, a: Alien, step: number, x: number, y: number, pose: Pose = {}) {
  const sprite = pose.shades ? inShades(a.frames[step % 2]!) : a.frames[step % 2]!;
  // Each sprite pixel as a PX by PX block.
  const rows = sprite.flatMap((r) => Array<string>(PX).fill([...r].map((c) => c.repeat(PX)).join('')));
  const h = rows.length;
  const w = rows[0]!.length;
  const tone: Record<string, RGB> = { B: a.body, D: a.shade, G: a.glow, W: WHITE, P: PUPIL, M: MOUTH, C: BLUSH, S: [8, 8, 12], g: WHITE };
  const sx = pose.sx ?? 1;
  const sy = pose.sy ?? 1;
  // Sampled from the sprite, so it stays pixel art at any squash.
  const sw = Math.max(1, Math.round(w * sx));
  const sh = Math.max(1, Math.round(h * sy));
  const ox = Math.round(x + (w - sw) / 2);
  const oy = y + (h - sh);
  const at = (i: number, j: number) => {
    const si = Math.min(w - 1, Math.floor(i / sx));
    return rows[Math.min(h - 1, Math.floor(j / sy))]![pose.flip ? w - 1 - si : si]!;
  };
  // The outline first: the silhouette in black, a pixel out each way.
  if (pose.outline)
    for (let j = 0; j < sh; j++)
      for (let i = 0; i < sw; i++) if (tone[at(i, j)]) for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) cv.set(ox + i + dx, oy + j + dy, [8, 8, 12]);
  for (let j = 0; j < sh; j++)
    for (let i = 0; i < sw; i++) {
      const c = tone[at(i, j)];
      if (c) cv.set(ox + i, oy + j, c);
    }
}

/** The portal: rings that breathe and turn, around a swirl. */
function drawPortal(cv: Canvas, cx: number, cy: number, t: number) {
  const rx = 13;
  const ry = 22;
  for (let y = -ry - 3; y <= ry + 3; y++)
    for (let x = -rx - 3; x <= rx + 3; x++) {
      const d = Math.sqrt((x / rx) ** 2 + (y / ry) ** 2);
      const ang = Math.atan2(y / ry, x / rx);
      if (d <= 1.0) {
        // The inside swirls: a spiral of the portal's colours on a dark ground, checkered for dither.
        const swirl = Math.sin(ang * 3 + d * 9 - t * 6);
        if (swirl > 0.35 && ((x + y) & 1) === 0) cv.set(cx + x, cy + y, mix(SPACE, PORTAL[Math.floor((d * 3 + t * 2) % 3)]!, 0.55));
        else if (swirl > 0.8) cv.set(cx + x, cy + y, mix(SPACE, PORTAL[2], 0.35));
      } else if (d <= 1.22) {
        // The rim: three bands that chase round.
        const band = Math.floor((ang / (Math.PI * 2) + 1 + t * 0.6) * 6) % 3;
        cv.set(cx + x, cy + y, PORTAL[band]!);
      } else if (d <= 1.35 && Math.sin(ang * 8 + t * 10) > 0.6) cv.set(cx + x, cy + y, mix(SPACE, PORTAL[0], 0.4));
    }
}

/** A colour from a hue (turns, any number), at full saturation: the disco's. */
function hue(h: number, v = 1): RGB {
  const x = (((h % 1) + 1) % 1) * 6;
  const c = (k: number) => Math.round(255 * v * Math.min(1, Math.max(0, Math.abs(((x + k) % 6) - 3) - 1)));
  return [c(0), c(4), c(2)];
}

/** Where the crew's feet are, and where the portal stands. */
const GROUND = 84;
const PORTAL_X = 162;
const PORTAL_Y = GROUND - 20;
const BAR_Y = SCENE_H - 8;

/**
 * Act one, in black and white: the crew trudging to the portal on a dotted ground, under the stars,
 * drawn in colour here and drained, grained and flickered by `silent`.
 */
function walk(cv: Canvas, f: number, t: number) {
  const tall = CREW[0]!.frames[0].length * PX;
  const wide = CREW[0]!.frames[0][0]!.length * PX;
  cv.fill(SPACE);
  for (const s of STARS) {
    const tw = Math.sin(s.phase + t * 5);
    if (tw > -0.3) cv.set(s.x, s.y, s.bright && tw > 0.5 ? STAR : STAR_DIM);
  }
  for (let x = 0; x < SCENE_W; x++) if ((x + f * 2) % 6 < 3) cv.set(x, GROUND + 1, STAR_DIM);
  drawPortal(cv, PORTAL_X, PORTAL_Y, t);
  // Each trudges at its own pace; past the portal's rim it shrinks into it.
  CREW.forEach((a, k) => {
    const x = k * 40 + 18 + t * (60 + k * 8) - wide;
    const hop = Math.round(Math.abs(Math.sin((t * 3 + k / 3) * Math.PI)) * 3);
    const into = x + wide - (PORTAL_X - 10);
    const scale = into > 0 ? Math.max(0, 1 - into / (wide + 4)) : 1;
    if (scale > 0.08) drawAlien(cv, a, Math.floor(t * 4 + k), x, GROUND - tall + 1 - hop, { sx: scale, sy: scale });
  });
}

/** An old film: grey, a grain that moves, a flicker, the odd scratch, and dark corners. */
function silent(cv: Canvas, f: number) {
  const r = rng(1000 + f);
  const flicker = 0.85 + r() * 0.3;
  const scratches = [Math.floor(r() * SCENE_W), r() > 0.5 ? Math.floor(r() * SCENE_W) : -1];
  for (let y = 0; y < SCENE_H; y++)
    for (let x = 0; x < SCENE_W; x++) {
      const i = (y * SCENE_W + x) * 3;
      const luma = 0.3 * cv.px[i]! + 0.59 * cv.px[i + 1]! + 0.11 * cv.px[i + 2]!;
      const dx = (x - SCENE_W / 2) / (SCENE_W / 2);
      const dy = (y - SCENE_H / 2) / (SCENE_H / 2);
      const vignette = 1 - 0.45 * Math.min(1, (dx * dx + dy * dy) / 1.6);
      let v = (luma * 1.15 + 18) * flicker * vignette + (r() - 0.5) * 38;
      if (scratches.includes(x) && r() > 0.15) v = 200 + r() * 40;
      v = Math.max(0, Math.min(255, Math.round(v)));
      cv.px[i] = cv.px[i + 1] = cv.px[i + 2] = v;
    }
}

/**
 * Act two: the disco the portal opened. Rainbow rays turn behind a mirror ball, the floor's tiles
 * light up on every beat, and the crew dance in a line in sunglasses: hopping out of step, squashing
 * as they land, turning on the beat.
 */
function disco(cv: Canvas, f: number, t: number) {
  const beat = t * (125 / 60);
  const cx = SCENE_W / 2;
  const cy = 16;
  // The rays, turning, each band its own colour, the whole wheel shifting hue.
  for (let y = 0; y < GROUND + 2; y++)
    for (let x = 0; x < SCENE_W; x++) {
      const ang = Math.atan2(y - cy, x - cx) / (Math.PI * 2);
      const band = Math.floor((ang + t * 0.35) * 16);
      const lit = band % 2 === 0;
      cv.set(x, y, hue(band / 16 + t * 0.5, lit ? 0.95 : 0.35));
    }
  // The floor: tiles that light up in colours on every beat, in perspective rows.
  const step = Math.floor(beat);
  for (let y = GROUND + 2; y < BAR_Y - 2; y++) {
    const row = Math.floor((y - GROUND - 2) / 4);
    const tw = 10 + row * 4;
    for (let x = 0; x < SCENE_W; x++) {
      const col = Math.floor((x - cx) / tw + 100);
      const r = rng(col * 31 + row * 7 + step * 1013)();
      const on = r > 0.45;
      cv.set(x, y, (y - GROUND - 2) % 4 === 3 || (x - cx) % tw === 0 ? [20, 20, 28] : on ? hue(r * 3 + beat * 0.25, 1) : [40, 34, 56]);
    }
  }
  for (let y = BAR_Y - 2; y < SCENE_H; y++) for (let x = 0; x < SCENE_W; x++) cv.set(x, y, [12, 10, 18]);
  // The mirror ball on its string, its facets catching the light as it turns.
  for (let y = 0; y < cy - 7; y++) cv.set(cx, y, [160, 160, 170]);
  for (let y = -7; y <= 7; y++)
    for (let x = -7; x <= 7; x++) {
      if (x * x + y * y > 49) continue;
      const facet = ((Math.floor((x + 8 + f) / 2) + Math.floor((y + 8) / 2)) & 1) === 0;
      cv.set(cx + x, cy + y, facet ? [230, 232, 240] : [120, 124, 140]);
    }
  const sparkle = rng(77 + f);
  for (let k = 0; k < 6; k++) {
    const sx = Math.floor(sparkle() * SCENE_W);
    const sy = Math.floor(sparkle() * (GROUND - 10));
    for (const [dx, dy] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]] as const) cv.set(sx + dx, sy + dy, WHITE);
  }
  // The crew, in a line, each a half beat from the next.
  const tall = CREW[0]!.frames[0].length * PX;
  CREW.forEach((a, k) => {
    const phase = beat + k * 0.5;
    const up = Math.abs(Math.sin(phase * Math.PI));
    const landing = up < 0.25;
    const x = 40 + k * 46 + Math.round(Math.sin(phase * Math.PI * 0.5) * 6);
    const pose: Pose = { sx: landing ? 1.25 : 0.92, sy: landing ? 0.78 : 1.12, flip: Math.floor(phase) % 2 === 1, shades: true, outline: true };
    drawAlien(cv, a, Math.floor(phase * 2), x, GROUND - tall + 1 - Math.round(up * 9), pose);
  });
}

/** The teleport beam along the bottom, filled as far as the clip has gone, and the clip's name on a plate. */
function chrome(cv: Canvas, f: number, frames: number, label: string, grey: boolean) {
  const filled = Math.round(((f + 1) / frames) * (SCENE_W - 30));
  for (let x = 0; x < SCENE_W - 30; x++) {
    const on = x < filled;
    const edge = filled - x;
    const c = on ? (edge <= 3 ? mix(PORTAL[0], WHITE, (4 - edge) / 4) : PORTAL[0]) : (x + f) % 4 === 0 ? STAR_DIM : SPACE;
    cv.set(12 + x, BAR_Y, c);
    if (on) cv.set(12 + x, BAR_Y + 1, mix(SPACE, PORTAL[0], 0.5));
  }
  cv.set(10, BAR_Y, PORTAL[1]);
  cv.set(SCENE_W - 16, BAR_Y, PORTAL[2]);
  const plate = (x: number, n: number) => {
    for (let y = 1; y < 10; y++) for (let i = -2; i < n * 4 + 1; i++) cv.set(x + i, y, SPACE);
  };
  plate(4, label.length);
  plate(SCENE_W - 12, 2);
  cv.text(label, 4, 3, grey ? [200, 200, 200] : STAR);
  cv.text(String(f).padStart(2, '0'), SCENE_W - 12, 3, STAR_DIM);
}

/**
 * The frames of a clip, as raw RGB at SCENE_W by SCENE_H, one after another. A third of it is a
 * silent film: the crew trudging to the portal in grainy black and white. Then the portal flashes and
 * colour floods out of it, and the rest is a disco, the crew dancing in sunglasses. The clip's name
 * stays in the corner and the beam fills along the bottom throughout.
 */
export function crewFrames(frames: number, fps: number, label: string): Buffer {
  const size = SCENE_W * SCENE_H * 3;
  const out = Buffer.alloc(size * frames);
  const turn = Math.max(1, Math.round(frames / 3));
  const FLASH = 3;
  for (let f = 0; f < frames; f++) {
    const t = f / fps;
    const cv = new Canvas(SCENE_W, SCENE_H);
    if (f < turn) {
      walk(cv, f, t);
      silent(cv, f);
    } else {
      disco(cv, f, t);
      // The first frames of colour flood out of the portal as a widening ring, black and white outside it.
      const k = f - turn;
      if (k < FLASH) {
        const old = new Canvas(SCENE_W, SCENE_H);
        walk(old, f, t);
        silent(old, f);
        const reach = ((k + 1) / FLASH) * Math.hypot(SCENE_W, SCENE_H);
        for (let y = 0; y < SCENE_H; y++)
          for (let x = 0; x < SCENE_W; x++) {
            const d = Math.hypot(x - PORTAL_X, (y - PORTAL_Y) * 1.6);
            const i = (y * SCENE_W + x) * 3;
            if (d > reach) old.px.copy(cv.px, i, i, i + 3);
            else if (d > reach - 8) cv.set(x, y, WHITE);
          }
      }
    }
    chrome(cv, f, frames, label, f < turn);
    cv.px.copy(out, f * size);
  }
  return out;
}
