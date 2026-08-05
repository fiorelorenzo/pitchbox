import { describe, expect, it } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
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
 * GET routes below) is admin+ only, the Status/Integrations data stays
 * member-visible. A no-op when auth is off (no `locals.org`), same
 * convention as `requireRole` - self-host keeps full access.
 *
 * #254 flattened the General page's four tabs into their own top-level
 * routes (`settings/status`, `settings/runners`, `settings/extension`,
 * `settings/quota`). The per-data-set gate from #237 had to survive the
 * split unchanged - same roles, now enforced in each route's own loader.
 * `settings/status` deliberately ships with no loader at all (daemon health
 * comes from a client store, and the extension `backendUrl` it also shows
 * is not privileged), so there is no server-side gate to test for it here -
 * only the three loaders below (`runners`, `extension`, `quota`) exist.
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
