import { describe, expect, it } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { actions } from '../src/routes/settings/retention/+page.server.js';

// The retention page saves via a SvelteKit form action, not the /api routes, so
// its admin gate lives on the action itself. Regression test for that gate.
function ev(role?: string): RequestEvent {
  return {
    locals: role ? { org: { id: 1, slug: 'x', role } } : {},
    request: new Request('http://x/', { method: 'POST' }),
  } as unknown as RequestEvent;
}

const run = actions.default as (e: RequestEvent) => Promise<unknown>;

describe('retention form action role gate', () => {
  it('rejects a member with 403', async () => {
    await expect(run(ev('member'))).rejects.toMatchObject({ status: 403 });
  });
  it('does not 403 an admin (passes the role gate)', async () => {
    const res = (await run(ev('admin')).catch((e) => e)) as { status?: number };
    expect(res?.status).not.toBe(403);
  });
  it('does not 403 with auth off (no locals.org)', async () => {
    const res = (await run(ev()).catch((e) => e)) as { status?: number };
    expect(res?.status).not.toBe(403);
  });
});
