import { describe, it, expect } from 'vitest';
import {
  CONFIG_SCHEMAS,
  parseConfigValue,
  isKnownConfigKey,
} from '../../src/projects/config-schemas.js';

describe('CONFIG_SCHEMAS', () => {
  it('round-trips product.pitch', () => {
    const v = { text: 'Acme makes rockets.' };
    expect(CONFIG_SCHEMAS['product.pitch'].parse(v)).toEqual(v);
  });

  it('rejects product.url with non-url string', () => {
    expect(() => CONFIG_SCHEMAS['product.url'].parse({ url: 'not-a-url' })).toThrow();
  });

  it('round-trips voice.dm_rules with empty arrays', () => {
    const v = { hardBans: [], dos: [], disclosure: '', examples: [] };
    expect(CONFIG_SCHEMAS['voice.dm_rules'].parse(v)).toEqual(v);
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

  it('round-trips topicAngles as string array', () => {
    expect(CONFIG_SCHEMAS['topicAngles'].parse(['a', 'b'])).toEqual(['a', 'b']);
  });

  it('round-trips offer with optional url', () => {
    const v = { name: 'Demo', cta: 'try it', composeSubject: 'hi' };
    expect(CONFIG_SCHEMAS['offer'].parse(v)).toEqual(v);
  });
});

describe('parseConfigValue', () => {
  it('uses registry schema for known key', () => {
    expect(parseConfigValue('topicAngles', ['x'])).toEqual(['x']);
  });

  it('returns value as-is for unknown key (must be JSON-serializable)', () => {
    expect(parseConfigValue('custom.unknown', { foo: 1 })).toEqual({ foo: 1 });
  });

  it('rejects unknown key value that is not JSON-serializable (function)', () => {
    expect(() => parseConfigValue('custom.unknown', () => 1 as unknown)).toThrow();
  });
});

describe('isKnownConfigKey', () => {
  it('returns true for known keys', () => {
    expect(isKnownConfigKey('voice.dm_rules')).toBe(true);
  });
  it('returns false for unknown keys', () => {
    expect(isKnownConfigKey('something.else')).toBe(false);
  });
});
