// Exercises shared/src/mastodon-source.ts: a `mastodon_account` project
// source whose text is an account's own public posts (#437). Real fixture
// HTTP servers throughout (not a mocked fetch) - the timeout and the post
// cap both depend on real network behaviour, the same reasoning
// website-source.test.ts documents for `website`. Unit-level coverage of
// `fetchPublicAccountStatuses` itself (the lookup-then-statuses shape,
// error propagation) lives in tests/platforms/mastodon/client.test.ts.
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb, getPool, schema } from '../src/db/client.js';
import { listProjectSources } from '../src/project-sources.js';
import {
  addMastodonAccountSource,
  MASTODON_MAX_POSTS,
  parseMastodonProfileUrl,
  refreshMastodonAccountSource,
} from '../src/mastodon-source.js';
import type { MastodonAccount, MastodonStatus } from '../src/platforms/mastodon/types.js';

// ---- Fixture server -------------------------------------------------------

type RouteHandler = (req: IncomingMessage, res: ServerResponse) => void;

async function startFixtureServer(
  routes: Record<string, RouteHandler>,
): Promise<{ origin: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    const handler = routes[pathname];
    if (!handler) {
      res.writeHead(404).end('not found');
      return;
    }
    handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}

async function startFixtureServerOnPort(
  port: string,
  routes: Record<string, RouteHandler>,
): Promise<{ origin: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    const handler = routes[pathname];
    if (!handler) {
      res.writeHead(404).end('not found');
      return;
    }
    handler(req, res);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(Number(port), '127.0.0.1', resolve);
  });
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}

function fakeAccount(overrides: Partial<MastodonAccount> = {}): MastodonAccount {
  return {
    id: '1',
    username: 'alice',
    acct: 'alice',
    display_name: 'Alice',
    url: 'https://mastodon.example/@alice',
    note: '',
    bot: false,
    locked: false,
    fields: [],
    followers_count: 0,
    following_count: 0,
    statuses_count: 0,
    created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function fakeStatus(overrides: Partial<MastodonStatus> = {}): MastodonStatus {
  return {
    id: '100',
    uri: 'https://mastodon.example/users/alice/statuses/100',
    url: 'https://mastodon.example/@alice/100',
    created_at: '2026-01-01T00:00:00.000Z',
    in_reply_to_id: null,
    in_reply_to_account_id: null,
    content: '<p>hello</p>',
    visibility: 'public',
    sensitive: false,
    spoiler_text: '',
    account: fakeAccount(),
    mentions: [],
    tags: [],
    replies_count: 0,
    reblogs_count: 0,
    favourites_count: 0,
    reblog: null,
    ...overrides,
  };
}

function lookupRoute(account: MastodonAccount): RouteHandler {
  return (_req, res) =>
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(account));
}

function statusesRoute(statuses: MastodonStatus[]): RouteHandler {
  return (_req, res) =>
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(statuses));
}

const openServers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (openServers.length > 0) await openServers.pop()!();
});

const createdOrgIds: number[] = [];
afterEach(async () => {
  const db = getDb();
  while (createdOrgIds.length > 0) {
    const id = createdOrgIds.pop()!;
    await db.delete(schema.organizations).where(eq(schema.organizations.id, id));
  }
});
afterAll(async () => {
  await getPool().end();
});

async function setupOrgAndProject() {
  const db = getDb();
  const slug = `mastodon-source-test-${randomUUID()}`;
  const [org] = await db.insert(schema.organizations).values({ slug, name: slug }).returning();
  createdOrgIds.push(org.id);
  const [project] = await db
    .insert(schema.projects)
    .values({ organizationId: org.id, slug: 'p', name: 'P' })
    .returning();
  return { orgId: org.id, projectId: project.id };
}

function outputText(output: unknown): string {
  if (
    !output ||
    typeof output !== 'object' ||
    !('text' in output) ||
    typeof output.text !== 'string'
  ) {
    throw new Error('expected a mastodon_account source output carrying text');
  }
  return output.text;
}

function fetchedPostCount(output: unknown): number {
  if (
    !output ||
    typeof output !== 'object' ||
    !('fetchedPostCount' in output) ||
    typeof output.fetchedPostCount !== 'number'
  ) {
    throw new Error('expected a mastodon_account source output carrying fetchedPostCount');
  }
  return output.fetchedPostCount;
}

// ---- parseMastodonProfileUrl ------------------------------------------------

describe('parseMastodonProfileUrl', () => {
  it('parses an instance origin and handle out of a profile URL', () => {
    expect(parseMastodonProfileUrl('https://mastodon.social/@Gargron')).toEqual({
      instanceUrl: 'https://mastodon.social',
      acct: 'Gargron',
    });
  });

  it('rejects a status permalink (not a profile)', () => {
    expect(parseMastodonProfileUrl('https://mastodon.social/@Gargron/12345')).toBeNull();
  });

  it('rejects a non-http(s) URL', () => {
    expect(parseMastodonProfileUrl('ftp://mastodon.social/@Gargron')).toBeNull();
  });

  it('rejects an unparseable URL', () => {
    expect(parseMastodonProfileUrl('not a url')).toBeNull();
  });
});

// ---- addMastodonAccountSource / refreshMastodonAccountSource (DB-backed) ---

describe('addMastodonAccountSource', () => {
  it('creates a source and fetches real-shaped text from a served fixture', async () => {
    const account = fakeAccount({ id: '9', acct: 'alice', display_name: 'Alice A.' });
    const { origin, close } = await startFixtureServer({
      '/api/v1/accounts/lookup': lookupRoute(account),
      '/api/v1/accounts/9/statuses': statusesRoute([
        fakeStatus({ id: '1', content: '<p>Shipping something new today.</p>' }),
        fakeStatus({ id: '2', content: '<p>Thanks for the feedback!</p>' }),
      ]),
    });
    openServers.push(close);
    const { orgId, projectId } = await setupOrgAndProject();
    const db = getDb();

    const result = await addMastodonAccountSource(db, orgId, projectId, `${origin}/@alice`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.source.kind).toBe('mastodon_account');
    expect(result.source.fetchError).toBeNull();
    expect(outputText(result.source.output)).toContain('Shipping something new today.');
    expect(outputText(result.source.output)).toContain('Thanks for the feedback!');
  });

  it('rejects a non-profile URL without creating a row', async () => {
    const { orgId, projectId } = await setupOrgAndProject();
    const db = getDb();

    const result = await addMastodonAccountSource(db, orgId, projectId, 'https://example.com');
    expect(result).toEqual({
      ok: false,
      code: 'invalid_url',
      reason: 'not a Mastodon profile URL (expected https://instance/@handle)',
    });
    expect(await listProjectSources(db, orgId, projectId)).toEqual([]);
  });

  it('does not create a source for a project in a different organization', async () => {
    const { projectId } = await setupOrgAndProject();
    const { orgId: otherOrgId } = await setupOrgAndProject();
    const db = getDb();

    const result = await addMastodonAccountSource(
      db,
      otherOrgId,
      projectId,
      'https://mastodon.social/@alice',
    );
    expect(result).toEqual({ ok: false, code: 'not_found' });
  });

  it('caps posts at MASTODON_MAX_POSTS against a fixture that offers more', async () => {
    const account = fakeAccount({ id: '9' });
    const many = Array.from({ length: 25 }, (_, i) => fakeStatus({ id: String(i) }));
    const { origin, close } = await startFixtureServer({
      '/api/v1/accounts/lookup': lookupRoute(account),
      '/api/v1/accounts/9/statuses': statusesRoute(many),
    });
    openServers.push(close);
    const { orgId, projectId } = await setupOrgAndProject();
    const db = getDb();

    const result = await addMastodonAccountSource(db, orgId, projectId, `${origin}/@alice`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(fetchedPostCount(result.source.output)).toBe(MASTODON_MAX_POSTS);
  });

  it('times out a lookup that never finishes responding, within the given budget', async () => {
    const { origin, close } = await startFixtureServer({
      '/api/v1/accounts/lookup': (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write('{"id": "9"');
        // Never calls res.end() - the connection just hangs.
      },
    });
    openServers.push(close);
    const { orgId, projectId } = await setupOrgAndProject();
    const db = getDb();

    const result = await addMastodonAccountSource(db, orgId, projectId, `${origin}/@alice`, {
      timeoutMs: 200,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.source.fetchError).toMatch(/timed out/);
  }, 5_000);

  it('a 404 lookup (unknown handle) fails only its own source, leaving the project readable', async () => {
    const { orgId, projectId } = await setupOrgAndProject();
    const db = getDb();

    const account = fakeAccount({ id: '9' });
    const { origin: goodOrigin, close } = await startFixtureServer({
      '/api/v1/accounts/lookup': lookupRoute(account),
      '/api/v1/accounts/9/statuses': statusesRoute([
        fakeStatus({ id: '1', content: '<p>I still work.</p>' }),
      ]),
    });
    openServers.push(close);
    const good = await addMastodonAccountSource(db, orgId, projectId, `${goodOrigin}/@alice`);
    expect(good.ok).toBe(true);

    const { origin: notFoundOrigin, close: closeNotFound } = await startFixtureServer({
      '/api/v1/accounts/lookup': (_req, res) =>
        res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({})),
    });
    openServers.push(closeNotFound);

    const failed = await addMastodonAccountSource(db, orgId, projectId, `${notFoundOrigin}/@ghost`);
    expect(failed.ok).toBe(true); // the row is created; only its own fetch fails
    if (failed.ok) {
      expect(failed.source.fetchError).toMatch(/404/);
      expect(failed.source.output).toBeNull();
    }

    const sources = await listProjectSources(db, orgId, projectId);
    expect(sources).toHaveLength(2);
    const stillGood = sources.find((s) => s.id === (good.ok ? good.source.id : -1));
    expect(stillGood?.fetchError).toBeNull();
    expect(outputText(stillGood?.output)).toContain('I still work.');
  });
});

describe('refreshMastodonAccountSource', () => {
  it('re-fetches in place, clearing a previous fetch_error on success', async () => {
    const { orgId, projectId } = await setupOrgAndProject();
    const db = getDb();

    const { origin, close } = await startFixtureServer({});
    await close(); // starts unreachable
    const created = await addMastodonAccountSource(db, orgId, projectId, `${origin}/@alice`);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.source.fetchError).not.toBeNull();

    const account = fakeAccount({ id: '9' });
    const { close: closeAgain } = await startFixtureServerOnPort(new URL(origin).port, {
      '/api/v1/accounts/lookup': lookupRoute(account),
      '/api/v1/accounts/9/statuses': statusesRoute([
        fakeStatus({ id: '1', content: '<p>Back online.</p>' }),
      ]),
    });
    openServers.push(closeAgain);

    await refreshMastodonAccountSource(db, created.source.id);
    const [refreshed] = await listProjectSources(db, orgId, projectId);
    expect(refreshed.fetchError).toBeNull();
    expect(outputText(refreshed.output)).toContain('Back online.');
  });

  it('is a no-op for a row that is not a mastodon_account source', async () => {
    const { orgId, projectId } = await setupOrgAndProject();
    const db = getDb();
    const [row] = await db
      .insert(schema.projectSources)
      .values({ projectId, kind: 'folder', config: { value: '/tmp/a' } })
      .returning();

    await expect(refreshMastodonAccountSource(db, row!.id)).resolves.toBeUndefined();
    const [after] = await listProjectSources(db, orgId, projectId);
    expect(after.fetchError).toBeNull();
    expect(after.fetchedAt).toBeNull();
  });
});
