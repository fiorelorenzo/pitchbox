import { describe, it, expect } from 'vitest';
import {
  CONFIG_SCHEMAS,
  parseConfigValue,
  isKnownConfigKey,
} from '../../src/projects/config-schemas.js';

describe('CONFIG_SCHEMAS', () => {
  it('rejects product.url with non-url string', () => {
    expect(() => CONFIG_SCHEMAS['product.url'].parse({ url: 'not-a-url' })).toThrow();
  });

  it('rejects voice.post_rules.lengthRange where min > max', () => {
    expect(() =>
      CONFIG_SCHEMAS['voice.post_rules'].parse({
        hardBans: [],
        dos: [],
        lengthRange: [200, 60],
      }),
    ).toThrow();
  });

  it('round-trips offer with optional url', () => {
    const v = { name: 'Demo', cta: 'try it', composeSubject: 'hi' };
    expect(CONFIG_SCHEMAS['offer'].parse(v)).toEqual(v);
  });

  it('accepts voice.post_rules with min === max boundary', () => {
    const v = { hardBans: [], dos: [], lengthRange: [100, 100] as [number, number] };
    expect(CONFIG_SCHEMAS['voice.post_rules'].parse(v)).toEqual(v);
  });
});

describe('parseConfigValue', () => {
  it('uses registry schema for known key', () => {
    expect(parseConfigValue('product.url', { url: 'https://x.com' })).toEqual({
      url: 'https://x.com',
    });
  });

  it('returns value as-is for unknown key (must be JSON-serializable)', () => {
    expect(parseConfigValue('custom.unknown', { foo: 1 })).toEqual({ foo: 1 });
  });

  it('rejects unknown key value that is not JSON-serializable (function)', () => {
    expect(() => parseConfigValue('custom.unknown', () => 1 as unknown)).toThrow();
  });

  it('rejects nested undefined for unknown key', () => {
    expect(() => parseConfigValue('custom.unknown', { a: 1, b: undefined })).toThrow();
  });

  it('rejects nested function for unknown key', () => {
    expect(() => parseConfigValue('custom.unknown', { fn: () => 1 })).toThrow();
  });

  it('rejects Date for unknown key', () => {
    expect(() => parseConfigValue('custom.unknown', { d: new Date() })).toThrow();
  });

  it('rejects circular reference for unknown key', () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    expect(() => parseConfigValue('custom.unknown', cyclic)).toThrow();
  });

  it('rejects NaN for unknown key', () => {
    expect(() => parseConfigValue('custom.unknown', { n: NaN })).toThrow();
  });

  it('returns the same value reference (no mutation) on success', () => {
    const v = { a: 1, b: [2, 3], c: { nested: 'ok' } };
    expect(parseConfigValue('custom.unknown', v)).toBe(v);
  });

  it('parseConfigValue invokes registry validation for known key (failure path)', () => {
    expect(() => parseConfigValue('product.url', { url: 'not-a-url' })).toThrow();
  });
});

describe('isKnownConfigKey', () => {
  it('returns true for known keys', () => {
    expect(isKnownConfigKey('voice.post_rules')).toBe(true);
  });
  it('returns false for unknown keys', () => {
    expect(isKnownConfigKey('something.else')).toBe(false);
  });
});
