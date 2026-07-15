import { describe, expect, it } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { load as retentionLoad } from '../src/routes/settings/retention/+page.server.js';
import { load as securityLoad } from '../src/routes/settings/security/+page.server.js';
import { POST as unlockPost } from '../src/routes/api/auth/unlock/+server.js';
import { GET as failuresGet } from '../src/routes/api/auth/failures/+server.js';

// requireRole reads locals.org.role. PITCHBOX_AUTH is unset in the test env, so
// requireSession (in the unlock endpoint) is a no-op and requireRole is the gate.
function loaderEvent(role: string | null): RequestEvent {
  return {
    locals: role ? { org: { id: 1, slug: 'default', role } } : {},
  } as unknown as RequestEvent;
}

function unlockEvent(role: string | null, body: unknown): RequestEvent {
  return {
    locals: role ? { org: { id: 1, slug: 'default', role } } : {},
    cookies: { get: () => undefined },
    request: new Request('http://x/', { method: 'POST', body: JSON.stringify(body) }),
  } as unknown as RequestEvent;
}

// Cast the generated PageServerLoad signatures down to a plain RequestEvent,
// same as retention-role.test.ts does for the form action: the $types are
// route-specific (ServerLoadEvent adds parent/depends/untrack) and don't accept
// a hand-built RequestEvent otherwise.
const retention = retentionLoad as (
  event: RequestEvent,
) => Promise<{ policy: unknown; floor: number }>;
const security = securityLoad as (
  event: RequestEvent,
) => Promise<{ policy: unknown; failures: unknown[] }>;

async function statusOf(fn: () => Promise<unknown>): Promise<number> {
  try {
    await fn();
    return 200;
  } catch (e) {
    return (e as { status?: number }).status ?? 500;
  }
}

describe('settings gating', () => {
  describe('retention load', () => {
    it('a member is forbidden (403)', async () => {
      expect(await statusOf(() => retention(loaderEvent('member')))).toBe(403);
    });
    it('an admin can load the policy', async () => {
      const data = await retention(loaderEvent('admin'));
      expect(data.policy).toBeDefined();
      expect(typeof data.floor).toBe('number');
    });
  });

  describe('security load', () => {
    it('a member is forbidden (403)', async () => {
      expect(await statusOf(() => security(loaderEvent('member')))).toBe(403);
    });
    it('an admin can load the failures list', async () => {
      const data = await security(loaderEvent('admin'));
      expect(data.policy).toBeDefined();
      expect(Array.isArray(data.failures)).toBe(true);
    });
  });

  describe('POST /api/auth/unlock', () => {
    it('a member is forbidden (403)', async () => {
      expect(await statusOf(() => unlockPost(unlockEvent('member', { username: 'someone' })))).toBe(
        403,
      );
    });
    it('an admin can unlock (200)', async () => {
      const res = await unlockPost(unlockEvent('admin', { username: 'someone' }));
      expect(res.status).toBe(200);
      expect((await res.json()).ok).toBe(true);
    });
    it('auth off (no org context) has full access (200)', async () => {
      const res = await unlockPost(unlockEvent(null, { username: 'someone' }));
      expect(res.status).toBe(200);
    });
  });

  // The security page reads failures via its own loader, but this API endpoint
  // exposes the same list and had no role check, so it is gated too.
  describe('GET /api/auth/failures', () => {
    it('a member is forbidden (403)', async () => {
      expect(await statusOf(() => failuresGet(loaderEvent('member')))).toBe(403);
    });
    it('an admin can read the failures list (200)', async () => {
      const res = await failuresGet(loaderEvent('admin'));
      expect(res.status).toBe(200);
      expect(Array.isArray((await res.json()).failures)).toBe(true);
    });
  });
});
