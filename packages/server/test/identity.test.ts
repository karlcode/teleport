import { describe, expect, it } from 'vitest';
import { identify, identityName } from '../src/ua.js';

describe('who a device is, from its user agent', () => {
  it('names an embedded build by its last bracketed vendor and model, and an Android build by its model', () => {
    const box = 'WPE/2.28.7 (Linux arm ; U; en), Acme_BOX_AMLS1234/1.0.100(Acme, ZX100)';
    expect(identityName(identify(box))).toBe('Acme ZX100');
    const android = 'Mozilla/5.0 (Linux; Android 9; Acme-Stick Build/ABC123) AppleWebKit/537.36 Chrome/130.0 Safari/537.36';
    expect(identify(android)).toMatchObject({ model: 'Acme-Stick', os: 'Android', osVersion: '9', source: 'user agent (Android build)' });
    expect(identityName(identify(android))).toBe('Acme-Stick Android 9');
  });

  it('reads the chip and the embedded engine, and names an unnamed box by them', () => {
    const box = 'WPE/2.28.7 (Linux arm ; U; en), Acme_BOX_AMLS1234/1.0.100(Acme, ZX100)';
    expect(identify(box).extra).toMatchObject({ chip: 'Amlogic S1234', engine: 'WPE WebKit 2.28.7' });
    const bare = 'Mozilla/5.0 (Linux armv7l; BCM12345) AppleWebKit/605.1.15 WPE/2.38.0';
    expect(identityName(identify(bare))).toBe('Linux Broadcom BCM12345 WPE WebKit 2.38.0');
  });

  it('names nothing it cannot read', () => {
    expect(identityName(identify(''))).toBeNull();
  });
});
