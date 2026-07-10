import { describe, expect, it } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { requireOrgId } from '../src/lib/server/auth.js';

function fakeEvent(org?: { id: number; slug: string; role: string }): RequestEvent {
  return { locals: { org }, request: new Request('http://x/') } as unknown as RequestEvent;
}

describe('requireOrgId', () => {
  it('returns the active org id from locals', async () => {
    const id = await requireOrgId(fakeEvent({ id: 42, slug: 's', role: 'owner' }));
    expect(id).toBe(42);
  });

  it('falls back to the default org when locals has none', async () => {
    // With auth off there is no locals.org; resolveOrgId returns the seeded default org.
    const id = await requireOrgId(fakeEvent(undefined));
    expect(typeof id).toBe('number');
  });
});
