// A short name for a user agent: the platform and the engine version, which decide what the app can use.
const PLATFORMS: [RegExp, string][] = [
  [/Android/, 'Android'],
  [/Macintosh/, 'macOS'],
  [/Windows/, 'Windows'],
  [/Linux/, 'Linux'],
];
const ENGINES: [RegExp, string][] = [
  [/HeadlessChrome\/(\d+)/, 'Headless Chrome'],
  [/Chrome\/(\d+)/, 'Chrome'],
  [/Firefox\/(\d+)/, 'Firefox'],
  [/Version\/(\d+)[\d.]* Safari/, 'Safari'],
];

export function describeUa(ua: string): string {
  const platform = PLATFORMS.find(([re]) => re.test(ua))?.[1];
  let engine: string | undefined;
  for (const [re, name] of ENGINES) {
    const m = re.exec(ua);
    if (m) {
      engine = `${name} ${m[1]}`;
      break;
    }
  }
  return [platform, engine].filter(Boolean).join(' · ') || ua || 'unknown browser';
}

export interface DeviceIdentity {
  brand: string | null;
  model: string | null;
  os: string | null;
  osVersion: string | null;
  /** Where in the user agent the model came from. */
  source: string | null;
  extra: Record<string, unknown>;
}

/** System-on-chip makers, as they show up in user agents, kernel strings and build names. */
const CHIPS: [RegExp, string][] = [
  [/(?<![A-Za-z0-9])AML([ST]\d{3,4}[A-Z\d]*)/i, 'Amlogic $1'],
  [/(?<![A-Za-z0-9])Amlogic[ _-]?([A-Z]?\d{3,4}[A-Z\d]*)?/i, 'Amlogic $1'],
  [/(?<![A-Za-z0-9])BCM ?(\d{4,5}[A-Z\d]*)/i, 'Broadcom BCM$1'],
  [/(?<![A-Za-z0-9])Broadcom\b/i, 'Broadcom'],
  [/(?<![A-Za-z0-9])(?:MStar|MSD)(\d{3,4}\w*)?/i, 'MStar $1'],
  [/(?<![A-Za-z0-9])(?:MediaTek|MTK|MT)(\d{4}\w*)\b/i, 'MediaTek MT$1'],
  [/(?<![A-Za-z0-9])Realtek ?(RTD?\d{4}\w*)?|(?<![A-Za-z0-9])RTD(\d{4}\w*)/i, 'Realtek $1$2'],
  [/(?<![A-Za-z0-9])Hi(37\d{2}\w*)|(?<![A-Za-z0-9])HiSilicon\b/i, 'HiSilicon Hi$1'],
  [/(?<![A-Za-z0-9])STi(\d{4}\w*)/i, 'STMicro STi$1'],
  [/(?<![A-Za-z0-9])Novatek\b|(?<![A-Za-z0-9])NT(\d{5})\b/i, 'Novatek $1'],
  [/(?<![A-Za-z0-9])Rockchip\b|(?<![A-Za-z0-9])RK(3\d{3})\b/i, 'Rockchip RK$1'],
];
/** Browser engines built for embedded devices, which say more about what runs than "Linux" does. */
const EMBEDDED: [RegExp, string][] = [
  [/WPE\/([\d.]+)/, 'WPE WebKit'],
  [/Cobalt\/([\d.]+)/, 'Cobalt'],
  [/QtWebEngine\/([\d.]+)/, 'QtWebEngine'],
  [/Chrome\/(\d+)/, 'Chromium'],
  [/AppleWebKit\/([\d.]+)/, 'WebKit'],
];

/** What the user agent says, without naming any one vendor: an Android build's model, the last
 *  bracketed (vendor, model) an embedded build tends to end with, the chip, and the engine. */
export function fromUa(ua: string): Partial<DeviceIdentity> & { chip: string | null; engine: string | null } {
  const out: Partial<DeviceIdentity> & { chip: string | null; engine: string | null } = { chip: null, engine: null };
  const clean = (s: string | undefined) => s?.replace(/^\s+|\s+$/g, '') || null;
  const and = /Android ([\d.]+);(?:[^;)]*;)*?\s*([^;()]+?)\s+Build\//.exec(ua);
  if (!out.model && and) Object.assign(out, { model: clean(and[2]), os: 'Android', osVersion: and[1], source: 'user agent (Android build)' });
  else if (/Android ([\d.]+)/.test(ua)) Object.assign(out, { os: out.os ?? 'Android', osVersion: out.osVersion ?? /Android ([\d.]+)/.exec(ua)![1] });
  const tail = /\(([^()]+)\)\s*$/.exec(ua);
  if (!out.model && tail && !/KHTML|compatible/i.test(tail[1]!)) {
    const p = tail[1]!.split(/[;,]/).map((x) => x.trim()).filter(Boolean);
    if (p.length > 1) Object.assign(out, { brand: p[0], model: p[p.length - 1], source: 'user agent' });
  }
  for (const [re, name] of CHIPS) {
    const m = re.exec(ua);
    if (m) {
      const [maker, ...rest] = name.split(' ');
      out.chip = `${maker} ${rest.join(' ').replace(/\$(\d)/g, (_, i: string) => m[Number(i)] ?? '').toUpperCase()}`.trim();
      break;
    }
  }
  for (const [re, name] of EMBEDDED) {
    const m = re.exec(ua);
    if (m) {
      out.engine = m[1] ? `${name} ${m[1]}` : name;
      break;
    }
  }
  if (/Linux/.test(ua) && !out.os) out.os = 'Linux';
  return out;
}

/** The device's identity, as its user agent gives it. */
export function identify(ua: string): DeviceIdentity {
  const u = fromUa(ua);
  const id: DeviceIdentity = { brand: u.brand ?? null, model: u.model ?? null, os: u.os ?? null, osVersion: u.osVersion ?? null, source: u.source ?? null, extra: {} };
  if (u.chip) id.extra.chip = u.chip;
  if (u.engine) id.extra.engine = u.engine;
  return id;
}

/** A folder name for the device: brand, model, OS release, e.g. `acme-zx100-android-9`; with no
 *  model, the chip and engine, so two unnamed boxes on different hardware don't share a folder. */
export function identityName(id: DeviceIdentity): string | null {
  const os = id.os ? `${id.os}${id.osVersion ? ' ' + id.osVersion : ''}` : '';
  if (id.model) return [id.brand, id.model, id.os === 'Linux' ? '' : os].filter(Boolean).join(' ');
  const hw = [id.extra.chip, id.extra.engine].filter(Boolean).join(' ');
  return hw || os ? [os, hw].filter(Boolean).join(' ') : null;
}
