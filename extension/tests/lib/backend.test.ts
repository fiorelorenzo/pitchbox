import { describe, expect, it } from 'vitest';
import { DEFAULT_BACKEND_URL, normalizeBackendUrl } from '../../src/lib/backend.js';

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

  it('defaults to production when no build-time override is set', () => {
    expect(DEFAULT_BACKEND_URL).toBe('https://pitchbox.app');
  });
});
