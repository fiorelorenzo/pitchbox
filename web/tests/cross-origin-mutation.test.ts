import { describe, expect, it } from 'vitest';
import { runThroughHandle, type CookieJar } from './helpers/handle-harness.js';

/**
 * #501: the hook that guards /api/* mutations compared the request's Origin
 * against `event.url.host`, and adapter-node builds `event.url` from the
 * ORIGIN env var rather than from the request's Host header. So once ORIGIN
 * moved to app.pitchbox.app (#424), a browser still on the apex - which the
 * same server was still answering - got a 403 `cross_origin_blocked` on
 * every mutation, while SvelteKit's own form check had already been given
 * both hosts in `csrf.trustedOrigins` for exactly that reason.
 *
 * Reproduced against the deployed prod build before the fix: a POST to
 * https://pitchbox.app/api/auth/login with `Origin: https://pitchbox.app`
 * answered 403 `cross_origin_blocked`, and the same POST with
 * `Origin: https://app.pitchbox.app` got through to the route (400
 * invalid_body). These tests are that shape: `event.url` on the app host,
 * the Origin header on the other one.
 */

function jar(): CookieJar {
  return { store: new Map() };
}

async function mutate(origin: string | null): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (origin) headers.origin = origin;
  const request = new Request('https://app.pitchbox.app/api/auth/login', {
    method: 'POST',
    headers,
    body: '{}',
  });
  // The route handler is a stand-in on purpose: what is under test is
  // whether the hook lets the request reach a handler at all.
  return runThroughHandle(request, jar(), async () => new Response('reached', { status: 200 }));
}

describe('cross-origin mutation guard (#501)', () => {
  it('lets the apex through while it is still a host of this deployment', async () => {
    for (const origin of ['https://pitchbox.app', 'https://www.pitchbox.app']) {
      const res = await mutate(origin);
      expect({ origin, status: res.status }).toEqual({ origin, status: 200 });
    }
  });

  it('lets the deployment its own origin through', async () => {
    expect((await mutate('https://app.pitchbox.app')).status).toBe(200);
  });

  it('still blocks an origin this deployment does not serve', async () => {
    for (const origin of [
      'https://evil.example',
      'http://pitchbox.app',
      'https://pitchbox.app.evil.example',
    ]) {
      const res = await mutate(origin);
      expect({ origin, status: res.status }).toEqual({ origin, status: 403 });
      expect(await res.json()).toEqual({ error: 'cross_origin_blocked' });
    }
  });

  it('still allows a request with no Origin header at all, as before', async () => {
    // A server-to-server caller sends none; the guard has never treated its
    // absence as cross-site, and this test exists so that stays deliberate.
    expect((await mutate(null)).status).toBe(200);
  });
});
