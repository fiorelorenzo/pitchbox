import { describe, expect, it } from 'vitest';
import { DEFAULT_BACKEND_URL, normalizeBackendUrl } from '../../src/lib/backend.js';
import { en } from '../../src/lib/i18n/dict-en.js';
import { it as itDict } from '../../src/lib/i18n/dict-it.js';

describe('normalizeBackendUrl', () => {
  it('accepts an https origin and strips path/query/trailing slash', () => {
    expect(normalizeBackendUrl('https://pitchbox.app/')).toBe('https://pitchbox.app');
    expect(normalizeBackendUrl('https://my.instance.example/dashboard?x=1')).toBe(
      'https://my.instance.example',
    );
  });

  it('assumes https for a bare host (preview / custom domain)', () => {
    expect(normalizeBackendUrl('preview.pitchbox.app')).toBe('https://preview.pitchbox.app');
  });

  it('keeps an explicit http origin with a port (self-host on a custom WEB_PORT)', () => {
    expect(normalizeBackendUrl('http://localhost:5199')).toBe('http://localhost:5199');
    expect(normalizeBackendUrl('http://127.0.0.1:5180/')).toBe('http://127.0.0.1:5180');
  });

  it('rejects empty input and non-http(s) schemes', () => {
    expect(normalizeBackendUrl('')).toBeNull();
    expect(normalizeBackendUrl('   ')).toBeNull();
    expect(normalizeBackendUrl('ftp://example.com')).toBeNull();
    expect(normalizeBackendUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeBackendUrl('data:text/html,x')).toBeNull();
  });

  it('defaults to production (app.pitchbox.app) when no build-time override is set', () => {
    expect(DEFAULT_BACKEND_URL).toBe('https://app.pitchbox.app');
  });
});

describe('the connection placeholder text', () => {
  // #424: the app moved off the apex to app.pitchbox.app. The build-time
  // default and the placeholder shown in the "add connection" form (both
  // locales) name the backend a fresh cloud install actually talks to - if
  // any of the three drifts, the placeholder just shows the wrong example
  // with nothing that flags the mismatch.
  it('agrees with the build-time default backend and across both locales', () => {
    expect(en['dashboard.connection.backend-placeholder']).toBe(DEFAULT_BACKEND_URL);
    expect(itDict['dashboard.connection.backend-placeholder']).toBe(DEFAULT_BACKEND_URL);
    expect(en['dashboard.connection.backend-placeholder']).toBe('https://app.pitchbox.app');
  });
});
