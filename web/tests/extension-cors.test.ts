import { describe, expect, it } from 'vitest';
import {
  EXTENSION_ALLOWED_ORIGINS,
  extensionCorsHeaders,
} from '../src/lib/server/extension-cors.js';

/**
 * #379: the allowlist held the two Reddit origins only, so every in-page
 * LinkedIn call died in the browser's preflight and the whole assistant did
 * nothing, on a server that looked healthy from curl. Each origin here is a
 * page the extension injects a content script into; anything else must get
 * the literal `null` back rather than a wildcard.
 */
describe('extension CORS allowlist', () => {
  it('allows every page origin the extension injects into', () => {
    for (const origin of [
      'https://www.linkedin.com',
      'https://www.reddit.com',
      'https://old.reddit.com',
    ]) {
      expect(extensionCorsHeaders(origin)['access-control-allow-origin']).toBe(origin);
    }
  });

  it('refuses an origin the extension does not run on', () => {
    for (const origin of [
      'https://evil.example',
      'https://linkedin.com',
      'http://www.linkedin.com',
      'https://www.linkedin.com.evil.example',
    ]) {
      expect(extensionCorsHeaders(origin)['access-control-allow-origin']).toBe('null');
    }
  });

  it('never answers with a wildcard, since a device token rides these calls', () => {
    for (const origin of [...EXTENSION_ALLOWED_ORIGINS, 'https://evil.example', null]) {
      expect(extensionCorsHeaders(origin)['access-control-allow-origin']).not.toBe('*');
    }
  });

  it('varies on Origin, so a cached preflight cannot leak across origins', () => {
    expect(extensionCorsHeaders('https://www.linkedin.com').vary).toBe('Origin');
  });

  it('allows the methods and headers the content scripts actually send', () => {
    const h = extensionCorsHeaders('https://www.linkedin.com');
    expect(h['access-control-allow-methods']).toContain('POST');
    expect(h['access-control-allow-headers']).toContain('authorization');
  });
});
