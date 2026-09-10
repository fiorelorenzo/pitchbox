import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '@pitchbox/shared/db';
import { AGENT_RUNNER_META } from '@pitchbox/shared/agents/meta';
import type { QuotaLimits } from '@pitchbox/shared/quota';
import {
  load as runnersLoad,
  type RunnerInfo,
} from '../src/routes/settings/runners/+page.server.js';
import { load as extensionLoad } from '../src/routes/settings/extension/+page.server.js';
import { load as quotaLoad } from '../src/routes/settings/quota/+page.server.js';
import { GET as defaultRunnerGet } from '../src/routes/api/settings/default-runner/+server.js';
import { GET as quotaGet } from '../src/routes/api/settings/quota/+server.js';
import { GET as runnerConfigGet } from '../src/routes/api/settings/runner-config/+server.js';

/**
 * #237: the General settings page (`web/src/routes/settings/+page.server.ts`)
 * had zero requireRole calls while its siblings (organization, retention,
 * security) all gate. Fixed per data set rather than page-wide: the Runners
 * and Quota tab data (also served by the default-runner/quota/runner-config
 * GET routes below) is admin+ only, the General/Integrations data stays
 * member-visible. A no-op when auth is off (no `locals.org`), same
 * convention as `requireRole` - self-host keeps full access.
 *
 * #254 flattened the General page's four tabs into their own top-level
 * routes (`settings/status` - since #186, `settings/general`
 * - `settings/runners`, `settings/extension`, `settings/quota`). The
 * per-data-set gate from #237 had to survive the split unchanged - same
 * roles, now enforced in each route's own loader. `settings/general`
 * deliberately ships with no loader at all (daemon health comes from a
 * client store, and the extension `backendUrl` it also shows is not
 * privileged), so there is no server-side gate to test for it here - only
 * the three loaders below (`runners`, `extension`, `quota`) exist.
 *
 * #183: on cloud, runner detection/config and quota defaults describe the
 * whole deployment, not any one tenant, so the per-org role is not the
 * right axis there (any user can self-create an org and become its
 * admin/owner). The gate for `runners`/`quota` and their GET-equivalent API
 * routes below narrows to `isInstanceAdmin` on cloud while staying
 * unchanged on self-host - see the "cloud edition" describe blocks below,
 * and `retention-role.test.ts` for the sibling `settings/retention` loader
 * (which already threw, so its gate is tested there instead of here).
 */

// `runners`/`extension`/`quota` loaders are typed via the generated
// `PageServerLoad` (a `ServerLoadEvent`, stricter than the plain
// `RequestEvent` the `+server.ts` handlers take), so build each fake event
// with that loader's own inferred parameter type rather than a
// separately-declared `RequestEvent`, matching route-guards-detail-pages.test.ts.
function loadEvent<T extends (event: never) => unknown>(
  url: string,
  locals: Record<string, unknown>,
): Parameters<T>[0] {
  return {
    locals,
    url: new URL(url),
  } as unknown as Parameters<T>[0];
}

function apiEvent(locals: Record<string, unknown>): RequestEvent {
  return {
    locals,
    request: new Request('http://x/api/settings/x'),
  } as unknown as RequestEvent;
}

// Real user row so `isInstanceAdmin`'s own DB lookup (event.locals.user.id
// -> users.is_instance_admin) runs for real rather than being hand-injected
// - same convention as retention-role.test.ts's `userWith` (no shared
// factory exists across these gating suites, so it is duplicated here).
async function userWith(username: string, isInstanceAdmin: boolean): Promise<{ id: number }> {
  await getDb()
    .insert(schema.users)
    .values({ username, passwordHash: 'x', isInstanceAdmin })
    .onConflictDoUpdate({
      target: schema.users.username,
      set: { isInstanceAdmin },
    });
  const [user] = await getDb()
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.username, username));
  return user;
}

// The loaders below are typed via the generated `PageServerLoad`, whose
// default `OutputData` always includes `void` in its type (svelte-kit's own
// `$types` machinery, unrelated to any redirect these loaders might throw -
// none of them do). These mirror each loader's actual, always-object return
// shape (see the corresponding `+page.server.ts`) so each `await ...Load()`
// call can be narrowed once at its call site instead of asserting per field.
type RunnersData = { isAdmin: boolean; runners: RunnerInfo[]; defaultRunner: string | null };
type ExtensionData = { isAdmin: boolean; extension: { backendUrl: string } };
type QuotaData = { isAdmin: boolean; quota: Record<string, QuotaLimits> };

describe('settings/runners/+page.server.ts load: per-data-set role gate', () => {
  it('gives a member isAdmin=false and no runner data', async () => {
    const data = (await runnersLoad(
      loadEvent<typeof runnersLoad>('http://x/settings/runners', {
        org: { id: 1, slug: 'x', role: 'member' },
      }),
    )) as RunnersData;
    expect(data.isAdmin).toBe(false);
    expect(data.runners).toEqual([]);
    expect(data.defaultRunner).toBeNull();
  });

  it('gives an admin the full runners payload', async () => {
    const data = (await runnersLoad(
      loadEvent<typeof runnersLoad>('http://x/settings/runners', {
        org: { id: 1, slug: 'x', role: 'admin' },
      }),
    )) as RunnersData;
    expect(data.isAdmin).toBe(true);
    expect(data.runners).toHaveLength(AGENT_RUNNER_META.length);
  });

  it('gives an owner the full runners payload', async () => {
    const data = (await runnersLoad(
      loadEvent<typeof runnersLoad>('http://x/settings/runners', {
        org: { id: 1, slug: 'x', role: 'owner' },
      }),
    )) as RunnersData;
    expect(data.isAdmin).toBe(true);
    expect(data.runners).toHaveLength(AGENT_RUNNER_META.length);
  });

  it('is a no-op when locals.org is unset (auth off / self-host): full access', async () => {
    const data = (await runnersLoad(
      loadEvent<typeof runnersLoad>('http://x/settings/runners', {}),
    )) as RunnersData;
    expect(data.isAdmin).toBe(true);
    expect(data.runners).toHaveLength(AGENT_RUNNER_META.length);
  });
});

describe('settings/extension/+page.server.ts load: backendUrl always visible', () => {
  it('gives a member the backendUrl and isAdmin=false', async () => {
    const data = (await extensionLoad(
      loadEvent<typeof extensionLoad>('http://x/settings/extension', {
        org: { id: 1, slug: 'x', role: 'member' },
      }),
    )) as ExtensionData;
    expect(data.isAdmin).toBe(false);
    // Not privileged - stays visible regardless of role.
    expect(typeof data.extension.backendUrl).toBe('string');
    expect(data.extension.backendUrl.length).toBeGreaterThan(0);
  });

  it('gives an admin isAdmin=true and the same backendUrl', async () => {
    const data = (await extensionLoad(
      loadEvent<typeof extensionLoad>('http://x/settings/extension', {
        org: { id: 1, slug: 'x', role: 'admin' },
      }),
    )) as ExtensionData;
    expect(data.isAdmin).toBe(true);
    expect(data.extension.backendUrl.length).toBeGreaterThan(0);
  });

  it('is a no-op when locals.org is unset (auth off / self-host): full access', async () => {
    const data = (await extensionLoad(
      loadEvent<typeof extensionLoad>('http://x/settings/extension', {}),
    )) as ExtensionData;
    expect(data.isAdmin).toBe(true);
  });
});

describe('settings/quota/+page.server.ts load: per-data-set role gate', () => {
  it('gives a member isAdmin=false and no quota data', async () => {
    const data = (await quotaLoad(
      loadEvent<typeof quotaLoad>('http://x/settings/quota', {
        org: { id: 1, slug: 'x', role: 'member' },
      }),
    )) as QuotaData;
    expect(data.isAdmin).toBe(false);
    expect(data.quota).toEqual({});
  });

  it('gives an admin isAdmin=true', async () => {
    const data = (await quotaLoad(
      loadEvent<typeof quotaLoad>('http://x/settings/quota', {
        org: { id: 1, slug: 'x', role: 'admin' },
      }),
    )) as QuotaData;
    expect(data.isAdmin).toBe(true);
  });

  it('gives an owner isAdmin=true', async () => {
    const data = (await quotaLoad(
      loadEvent<typeof quotaLoad>('http://x/settings/quota', {
        org: { id: 1, slug: 'x', role: 'owner' },
      }),
    )) as QuotaData;
    expect(data.isAdmin).toBe(true);
  });

  it('is a no-op when locals.org is unset (auth off / self-host): full access', async () => {
    const data = (await quotaLoad(
      loadEvent<typeof quotaLoad>('http://x/settings/quota', {}),
    )) as QuotaData;
    expect(data.isAdmin).toBe(true);
  });
});

describe('api/settings/{default-runner,quota,runner-config} GET: admin-gated view', () => {
  const routes: Array<[string, (event: RequestEvent) => Promise<Response>]> = [
    ['default-runner', defaultRunnerGet],
    ['quota', quotaGet],
    ['runner-config', runnerConfigGet],
  ];

  for (const [name, handler] of routes) {
    describe(`GET /api/settings/${name}`, () => {
      it('rejects a member with 403', async () => {
        const event = apiEvent({ org: { id: 1, slug: 'x', role: 'member' } });
        await expect(handler(event)).rejects.toMatchObject({ status: 403 });
      });

      it('allows an admin', async () => {
        const event = apiEvent({ org: { id: 1, slug: 'x', role: 'admin' } });
        const res = await handler(event);
        expect(res.status).toBe(200);
      });

      it('is a no-op when locals.org is unset (auth off / self-host)', async () => {
        const event = apiEvent({});
        const res = await handler(event);
        expect(res.status).toBe(200);
      });
    });
  }
});

// #183: on cloud, an org's own role is not the right axis for instance-wide
// config (any user can self-create an org and become its admin/owner), so
// these narrow to `isInstanceAdmin` there instead - a member and an org
// owner who is not the instance admin both get the same "no data" shape a
// self-host member gets, and only the instance admin is served. Self-host
// behaviour (the describe blocks above) is untouched, and the "edition
// unset" cases above already cover that nothing changes when
// `PITCHBOX_EDITION` is unset.
describe('cloud edition: runners/quota loaders and GET routes gate on instance admin (#183)', () => {
  const savedEdition = process.env.PITCHBOX_EDITION;
  beforeEach(() => {
    process.env.PITCHBOX_EDITION = 'cloud';
  });
  afterEach(() => {
    if (savedEdition === undefined) delete process.env.PITCHBOX_EDITION;
    else process.env.PITCHBOX_EDITION = savedEdition;
  });

  describe('settings/runners/+page.server.ts load', () => {
    it('gives a member isAdmin=false and no runner data', async () => {
      const user = await userWith('lor183-cloud-runners-member', false);
      const data = (await runnersLoad(
        loadEvent<typeof runnersLoad>('http://x/settings/runners', {
          user,
          org: { id: 1, slug: 'x', role: 'member' },
        }),
      )) as RunnersData;
      expect(data.isAdmin).toBe(false);
      expect(data.runners).toEqual([]);
    });

    it('gives an org owner who is not instance admin isAdmin=false and no runner data', async () => {
      const user = await userWith('lor183-cloud-runners-owner', false);
      const data = (await runnersLoad(
        loadEvent<typeof runnersLoad>('http://x/settings/runners', {
          user,
          org: { id: 1, slug: 'x', role: 'owner' },
        }),
      )) as RunnersData;
      expect(data.isAdmin).toBe(false);
      expect(data.runners).toEqual([]);
    });

    it('gives the instance admin the full runners payload', async () => {
      const user = await userWith('lor183-cloud-runners-iadmin', true);
      const data = (await runnersLoad(
        loadEvent<typeof runnersLoad>('http://x/settings/runners', {
          user,
          org: { id: 1, slug: 'x', role: 'member' },
        }),
      )) as RunnersData;
      expect(data.isAdmin).toBe(true);
      expect(data.runners.length).toBeGreaterThan(0);
    });
  });

  describe('settings/quota/+page.server.ts load', () => {
    it('gives a member isAdmin=false and no quota data', async () => {
      const user = await userWith('lor183-cloud-quota-member', false);
      const data = (await quotaLoad(
        loadEvent<typeof quotaLoad>('http://x/settings/quota', {
          user,
          org: { id: 1, slug: 'x', role: 'member' },
        }),
      )) as QuotaData;
      expect(data.isAdmin).toBe(false);
      expect(data.quota).toEqual({});
    });

    it('gives an org owner who is not instance admin isAdmin=false and no quota data', async () => {
      const user = await userWith('lor183-cloud-quota-owner', false);
      const data = (await quotaLoad(
        loadEvent<typeof quotaLoad>('http://x/settings/quota', {
          user,
          org: { id: 1, slug: 'x', role: 'owner' },
        }),
      )) as QuotaData;
      expect(data.isAdmin).toBe(false);
      expect(data.quota).toEqual({});
    });

    it('gives the instance admin isAdmin=true', async () => {
      const user = await userWith('lor183-cloud-quota-iadmin', true);
      const data = (await quotaLoad(
        loadEvent<typeof quotaLoad>('http://x/settings/quota', {
          user,
          org: { id: 1, slug: 'x', role: 'member' },
        }),
      )) as QuotaData;
      expect(data.isAdmin).toBe(true);
    });
  });

  const routes: Array<[string, (event: RequestEvent) => Promise<Response>]> = [
    ['default-runner', defaultRunnerGet],
    ['quota', quotaGet],
    ['runner-config', runnerConfigGet],
  ];

  for (const [name, handler] of routes) {
    describe(`GET /api/settings/${name}`, () => {
      it('rejects a member with 403', async () => {
        const user = await userWith(`lor183-cloud-${name}-member`, false);
        const event = apiEvent({ user, org: { id: 1, slug: 'x', role: 'member' } });
        await expect(handler(event)).rejects.toMatchObject({ status: 403 });
      });

      it('rejects an org owner who is not instance admin with 403', async () => {
        const user = await userWith(`lor183-cloud-${name}-owner`, false);
        const event = apiEvent({ user, org: { id: 1, slug: 'x', role: 'owner' } });
        await expect(handler(event)).rejects.toMatchObject({ status: 403 });
      });

      it('allows the instance admin', async () => {
        const user = await userWith(`lor183-cloud-${name}-iadmin`, true);
        const event = apiEvent({ user, org: { id: 1, slug: 'x', role: 'member' } });
        const res = await handler(event);
        expect(res.status).toBe(200);
      });
    });
  }
});
