import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { getDb, schema } from '@pitchbox/shared/db';
import { listInstallations, recordInstallation } from '@pitchbox/shared/github-app';
import {
  decodeInstallState,
  encodeInstallState,
  INSTALL_STATE_TTL_MS,
} from '../src/lib/server/github-install-state.js';
import { GET as setupGET } from '../src/routes/api/integrations/github/setup/+server.js';
import { GET as installGET } from '../src/routes/api/integrations/github/install/+server.js';

// The GitHub App install round trip (#390). Everything arriving at the setup
// callback is attacker-supplied: it is a GET with two query parameters. So
// what this file defends is every refusal on the way in, and it defends them
// by asserting that no row was written, not just that a redirect said no.

const PEM = generateKeyPairSync('rsa', { modulusLength: 2048 })
  .privateKey.export({ type: 'pkcs1', format: 'pem' })
  .toString();

const APP_ENV = {
  GITHUB_APP_ID: '4883602',
  GITHUB_APP_SLUG: 'pitchbox-companion',
  GITHUB_APP_PRIVATE_KEY_B64: Buffer.from(PEM).toString('base64'),
};

const saved: Record<string, string | undefined> = {};
function setEnv(vars: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(vars)) {
    if (!(k in saved)) saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

type SetupEvent = Parameters<typeof setupGET>[0];

function setupEvent(
  orgId: number | null,
  role: string,
  params: Record<string, string>,
): SetupEvent {
  const url = new URL('http://x/api/integrations/github/setup');
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return {
    url,
    locals: orgId == null ? {} : { org: { id: orgId, slug: 'x', role }, user: { id: 1 } },
    request: new Request(url),
  } as unknown as SetupEvent;
}

/** The routes call GitHub through the shared module's default fetch, so the
 * global is what a test has to substitute. Only `/app/installations/<id>` is
 * ever reached from the setup route. */
function stubGithub(handler: (url: string) => Response) {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => handler(String(input))) as typeof globalThis.fetch;
  return () => {
    globalThis.fetch = original;
  };
}

const installationJson = (login: string) =>
  new Response(
    JSON.stringify({
      id: 160289335,
      account: { login, type: 'User' },
      repository_selection: 'selected',
      permissions: { contents: 'read', metadata: 'read' },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

/** A redirect leaves a route as a thrown `Redirect`, so the assertion has to
 * catch it. Returns the `github=` result the operator will see. */
async function resultOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (thrown) {
    const location = (thrown as { location?: string }).location;
    if (!location) throw thrown;
    return new URL(location, 'http://x').searchParams.get('github') ?? '';
  }
  throw new Error('expected a redirect');
}

/** Same idea as `resultOf`, but keeps the full redirect target rather than
 * just the `github=` result - for asserting exactly which page the BACK
 * constant in the route under test sends the operator back to. */
async function locationOf(promise: Promise<unknown>): Promise<URL> {
  try {
    await promise;
  } catch (thrown) {
    const location = (thrown as { location?: string }).location;
    if (!location) throw thrown;
    return new URL(location, 'http://x');
  }
  throw new Error('expected a redirect');
}

describe('install state', () => {
  beforeEach(() => setEnv({ ENCRYPTION_KEY: 'a'.repeat(64) }));

  it('round-trips the organization that started the install', () => {
    const state = encodeInstallState(7, 3);
    expect(decodeInstallState(state)).toEqual({ ok: true, orgId: 7, userId: 3 });
  });

  it('refuses a tampered payload, which is the point of signing it', () => {
    const signature = encodeInstallState(7, 3).split('.')[1];
    const forged = Buffer.from(
      JSON.stringify({ orgId: 999, userId: 3, nonce: 'x', exp: Date.now() + 1000 }),
    ).toString('base64url');
    expect(decodeInstallState(`${forged}.${signature}`)).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('expires, so a state left in a browser history is useless', () => {
    const state = encodeInstallState(7, 3, new Date(Date.now() - INSTALL_STATE_TTL_MS - 1000));
    expect(decodeInstallState(state)).toEqual({ ok: false, reason: 'expired' });
  });
});

describe('the install redirect', () => {
  afterEach(() => setEnv(saved));

  it('is a 501 rather than a 404 when the deployment has no app', async () => {
    setEnv({
      GITHUB_APP_ID: undefined,
      GITHUB_APP_SLUG: undefined,
      GITHUB_APP_PRIVATE_KEY_B64: undefined,
    });
    const event = setupEvent(1, 'admin', {});
    await expect(
      installGET(event as unknown as Parameters<typeof installGET>[0]),
    ).rejects.toMatchObject({
      status: 501,
    });
  });

  it('sends an admin to the app with a signed state', async () => {
    setEnv({ ...APP_ENV, ENCRYPTION_KEY: 'a'.repeat(64) });
    let location = '';
    try {
      await installGET(setupEvent(1, 'admin', {}) as unknown as Parameters<typeof installGET>[0]);
    } catch (thrown) {
      location = (thrown as { location: string }).location;
    }
    const url = new URL(location);
    expect(url.pathname).toBe('/apps/pitchbox-companion/installations/new');
    expect(decodeInstallState(url.searchParams.get('state'))).toMatchObject({ ok: true, orgId: 1 });
  });

  it('refuses a member', async () => {
    setEnv({ ...APP_ENV, ENCRYPTION_KEY: 'a'.repeat(64) });
    await expect(
      installGET(setupEvent(1, 'member', {}) as unknown as Parameters<typeof installGET>[0]),
    ).rejects.toMatchObject({ status: 403 });
  });
});

describe('the setup callback', () => {
  let orgA: number;
  let orgB: number;
  let restoreFetch: (() => void) | null = null;

  beforeEach(async () => {
    setEnv({ ...APP_ENV, ENCRYPTION_KEY: 'a'.repeat(64) });
    const db = getDb();
    await db.execute(sql`TRUNCATE github_installations RESTART IDENTITY CASCADE`);
    await db.execute(sql`DELETE FROM organizations WHERE slug LIKE 'ghflow-%'`);
    const [a] = await db
      .insert(schema.organizations)
      .values({ slug: 'ghflow-a', name: 'a' })
      .returning();
    const [b] = await db
      .insert(schema.organizations)
      .values({ slug: 'ghflow-b', name: 'b' })
      .returning();
    orgA = a.id;
    orgB = b.id;
  });

  afterEach(() => {
    restoreFetch?.();
    restoreFetch = null;
    setEnv(saved);
  });

  it('records the installation after verifying it against GitHub', async () => {
    restoreFetch = stubGithub(() => installationJson('fiorelorenzo'));
    const state = encodeInstallState(orgA, 1);
    const result = await resultOf(
      setupGET(
        setupEvent(orgA, 'admin', { installation_id: '160289335', setup_action: 'install', state }),
      ),
    );
    expect(result).toBe('installed');
    const rows = await listInstallations(getDb(), orgA);
    expect(rows).toMatchObject([{ accountLogin: 'fiorelorenzo', installationId: 160289335 }]);
  });

  it('redirects back to companion/work, not the retired settings route (LOR-178/LOR-179)', async () => {
    restoreFetch = stubGithub(() => installationJson('fiorelorenzo'));
    const state = encodeInstallState(orgA, 1);
    const location = await locationOf(
      setupGET(
        setupEvent(orgA, 'admin', { installation_id: '160289335', setup_action: 'install', state }),
      ),
    );
    expect(location.pathname).toBe('/companion/work');
  });

  it('refuses an installation id GitHub will not confirm, and writes nothing', async () => {
    // The forged-id case: `installation_id` is a query parameter, so somebody
    // can paste a stranger's. It is checked with the app JWT, where an
    // installation of another app answers 404.
    restoreFetch = stubGithub(() => new Response('{}', { status: 404 }));
    const state = encodeInstallState(orgA, 1);
    const result = await resultOf(
      setupGET(setupEvent(orgA, 'admin', { installation_id: '160289335', state })),
    );
    expect(result).toBe('unverified');
    expect(await listInstallations(getDb(), orgA)).toHaveLength(0);
  });

  it('refuses a state minted for another organization', async () => {
    restoreFetch = stubGithub(() => installationJson('fiorelorenzo'));
    const state = encodeInstallState(orgB, 1);
    const result = await resultOf(
      setupGET(setupEvent(orgA, 'admin', { installation_id: '160289335', state })),
    );
    expect(result).toBe('wrong_org');
    expect(await listInstallations(getDb(), orgA)).toHaveLength(0);
    expect(await listInstallations(getDb(), orgB)).toHaveLength(0);
  });

  it('refuses an unsigned state, which is what an install from GitHub\u0027s directory looks like', async () => {
    restoreFetch = stubGithub(() => installationJson('fiorelorenzo'));
    const result = await resultOf(
      setupGET(setupEvent(orgA, 'admin', { installation_id: '160289335' })),
    );
    expect(result).toBe('no_state');
    expect(await listInstallations(getDb(), orgA)).toHaveLength(0);
  });

  it('refuses a member even with a valid state', async () => {
    restoreFetch = stubGithub(() => installationJson('fiorelorenzo'));
    const state = encodeInstallState(orgA, 1);
    const result = await resultOf(
      setupGET(setupEvent(orgA, 'member', { installation_id: '160289335', state })),
    );
    expect(result).toBe('forbidden');
    expect(await listInstallations(getDb(), orgA)).toHaveLength(0);
  });

  it('refuses an installation another organization already holds', async () => {
    await recordInstallation(getDb(), orgB, {
      installationId: 160289335,
      accountLogin: 'fiorelorenzo',
      accountType: 'User',
      repositorySelection: 'selected',
      permissions: { contents: 'read' },
    });
    restoreFetch = stubGithub(() => installationJson('fiorelorenzo'));
    const state = encodeInstallState(orgA, 1);
    const result = await resultOf(
      setupGET(setupEvent(orgA, 'admin', { installation_id: '160289335', state })),
    );
    expect(result).toBe('claimed_by_other_org');
    expect(await listInstallations(getDb(), orgA)).toHaveLength(0);
    expect(await listInstallations(getDb(), orgB)).toHaveLength(1);
  });

  it('says so when an install needs an owner to approve it', async () => {
    const state = encodeInstallState(orgA, 1);
    const result = await resultOf(
      setupGET(setupEvent(orgA, 'admin', { setup_action: 'request', installation_id: '0', state })),
    );
    expect(result).toBe('requested');
  });
});
