// Exercises shared/src/hackernews-source.ts: a `hackernews_author`
// project_sources kind whose text is an HN user's own submissions (#437).
// Real fixture HTTP servers throughout (not a mocked fetch) - the timeout
// and the item-count cap both depend on real network behaviour, the same
// reasoning website-source.test.ts documents for `website`. Unit-level
// coverage of `fetchUserSubmissions` itself (candidate sorting/filtering,
// the candidate-hydration cap) lives in
// tests/platforms/hackernews/hackernews.test.ts.
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb, getPool, schema } from '../src/db/client.js';
import { listProjectSources } from '../src/project-sources.js';
import { HN_AUTHOR_MAX_ITEMS } from '../src/platforms/hackernews/client.js';
import {
  addHackernewsAuthorSource,
  parseHackernewsUsername,
  refreshHackernewsAuthorSource,
  type HackernewsRawFetch,
} from '../src/hackernews-source.js';

// ---- Fixture server -------------------------------------------------------
// The real HN adapter always requests `https://hacker-news.firebaseio.com/v0/...`;
// this fetchImpl rewrites that origin to a local fixture server's, keeping
// the path/query so the fixture serves the exact same request shape.

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

function fetchAgainst(origin: string): HackernewsRawFetch {
  return (url, init) => {
    const target = new URL(url);
    return fetch(origin + target.pathname + target.search, init);
  };
}

function userRoute(submitted: number[]): RouteHandler {
  return (_req, res) =>
    res
      .writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify({ id: 'pg', submitted }));
}

function itemRoute(idToItem: Record<number, unknown>): RouteHandler {
  return (req, res) => {
    const id = Number(
      new URL(req.url ?? '/', 'http://localhost').pathname.match(/\/item\/(\d+)\.json$/)?.[1],
    );
    res
      .writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify(idToItem[id] ?? null));
  };
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
  const slug = `hn-source-test-${randomUUID()}`;
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
    throw new Error('expected a hackernews_author source output carrying text');
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
    throw new Error('expected a hackernews_author source output carrying fetchedPostCount');
  }
  return output.fetchedPostCount;
}

// ---- parseHackernewsUsername -----------------------------------------------

describe('parseHackernewsUsername', () => {
  it('accepts a bare username', () => {
    expect(parseHackernewsUsername('pg')).toBe('pg');
  });

  it('accepts a profile URL and pulls the id query param', () => {
    expect(parseHackernewsUsername('https://news.ycombinator.com/user?id=pg')).toBe('pg');
  });

  it('rejects a non-HN URL', () => {
    expect(parseHackernewsUsername('https://example.com/user?id=pg')).toBeNull();
  });

  it('rejects an item permalink (no id query param)', () => {
    expect(parseHackernewsUsername('https://news.ycombinator.com/item?id=123')).toBeNull();
  });

  it('rejects an empty or whitespace-only input', () => {
    expect(parseHackernewsUsername('  ')).toBeNull();
  });
});

// ---- addHackernewsAuthorSource / refreshHackernewsAuthorSource (DB-backed) -

describe('addHackernewsAuthorSource', () => {
  it('creates a source and fetches real-shaped text from a served fixture', async () => {
    const { origin, close } = await startFixtureServer({
      '/v0/user/pg.json': userRoute([1, 2]),
      '/v0/item/1.json': itemRoute({
        1: {
          id: 1,
          type: 'story',
          by: 'pg',
          time: 1_700_000_000,
          title: 'Ask HN: How do you validate a new idea?',
          text: 'Curious what people actually do before building.',
        },
      }),
      '/v0/item/2.json': itemRoute({
        2: {
          id: 2,
          type: 'story',
          by: 'pg',
          time: 1_700_000_100,
          title: 'Show HN: A tool I built',
          url: 'https://example.com/tool',
        },
      }),
    });
    openServers.push(close);
    const { orgId, projectId } = await setupOrgAndProject();
    const db = getDb();

    const result = await addHackernewsAuthorSource(db, orgId, projectId, 'pg', {
      fetchImpl: fetchAgainst(origin),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.source.kind).toBe('hackernews_author');
    expect(result.source.fetchError).toBeNull();
    expect(outputText(result.source.output)).toContain('Ask HN: How do you validate a new idea?');
    expect(outputText(result.source.output)).toContain('Show HN: A tool I built');
    expect(outputText(result.source.output)).toContain('https://example.com/tool');
  });

  it('rejects an invalid username without creating a row', async () => {
    const { orgId, projectId } = await setupOrgAndProject();
    const db = getDb();

    const result = await addHackernewsAuthorSource(db, orgId, projectId, 'https://example.com/x');
    expect(result).toEqual({
      ok: false,
      code: 'invalid_username',
      reason: 'not a valid Hacker News username or profile URL',
    });
    expect(await listProjectSources(db, orgId, projectId)).toEqual([]);
  });

  it('does not create a source for a project in a different organization', async () => {
    const { projectId } = await setupOrgAndProject();
    const { orgId: otherOrgId } = await setupOrgAndProject();
    const db = getDb();

    const result = await addHackernewsAuthorSource(db, otherOrgId, projectId, 'pg');
    expect(result).toEqual({ ok: false, code: 'not_found' });
  });

  it('caps posts at HN_AUTHOR_MAX_ITEMS against a fixture that offers more', async () => {
    const submitted = Array.from({ length: 20 }, (_, i) => 100 + i);
    const idToItem: Record<number, unknown> = {};
    for (const id of submitted) {
      idToItem[id] = { id, type: 'story', by: 'pg', time: id, title: `Story ${id}` };
    }
    const { origin, close } = await startFixtureServer({
      '/v0/user/pg.json': userRoute(submitted),
      ...Object.fromEntries(
        submitted.map((id) => [`/v0/item/${id}.json`, itemRoute(idToItem)] as const),
      ),
    });
    openServers.push(close);
    const { orgId, projectId } = await setupOrgAndProject();
    const db = getDb();

    const result = await addHackernewsAuthorSource(db, orgId, projectId, 'pg', {
      fetchImpl: fetchAgainst(origin),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(fetchedPostCount(result.source.output)).toBe(HN_AUTHOR_MAX_ITEMS);
  });

  it('times out a user lookup that never finishes responding, within the given budget', async () => {
    const { origin, close } = await startFixtureServer({
      '/v0/user/pg.json': (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write('{"submitted": [1');
        // Never calls res.end() - the connection just hangs.
      },
    });
    openServers.push(close);
    const { orgId, projectId } = await setupOrgAndProject();
    const db = getDb();

    const result = await addHackernewsAuthorSource(db, orgId, projectId, 'pg', {
      fetchImpl: fetchAgainst(origin),
      timeoutMs: 200,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.source.fetchError).toMatch(/timed out/);
  }, 5_000);

  it('an unreachable host fails only its own source, leaving the project (and its other sources) readable', async () => {
    const { orgId, projectId } = await setupOrgAndProject();
    const db = getDb();

    const { origin: goodOrigin, close } = await startFixtureServer({
      '/v0/user/pg.json': userRoute([1]),
      '/v0/item/1.json': itemRoute({ 1: { id: 1, type: 'story', by: 'pg', title: 'Still works' } }),
    });
    openServers.push(close);
    const good = await addHackernewsAuthorSource(db, orgId, projectId, 'pg', {
      fetchImpl: fetchAgainst(goodOrigin),
    });
    expect(good.ok).toBe(true);

    const { origin: deadOrigin, close: closeDead } = await startFixtureServer({});
    await closeDead(); // nothing listens here

    const failed = await addHackernewsAuthorSource(db, orgId, projectId, 'alice', {
      fetchImpl: fetchAgainst(deadOrigin),
    });
    expect(failed.ok).toBe(true); // the row is created; only its own fetch fails
    if (failed.ok) {
      expect(failed.source.fetchError).toMatch(/network error/);
      expect(failed.source.output).toBeNull();
    }

    const sources = await listProjectSources(db, orgId, projectId);
    expect(sources).toHaveLength(2);
    const stillGood = sources.find((s) => s.id === (good.ok ? good.source.id : -1));
    expect(stillGood?.fetchError).toBeNull();
    expect(outputText(stillGood?.output)).toContain('Still works');
  });
});

describe('refreshHackernewsAuthorSource', () => {
  it('re-fetches in place, clearing a previous fetch_error on success', async () => {
    const { orgId, projectId } = await setupOrgAndProject();
    const db = getDb();

    const { origin, close } = await startFixtureServer({});
    await close(); // starts unreachable
    const created = await addHackernewsAuthorSource(db, orgId, projectId, 'pg', {
      fetchImpl: fetchAgainst(origin),
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.source.fetchError).not.toBeNull();

    const { close: closeAgain } = await startFixtureServerOnPort(new URL(origin).port, {
      '/v0/user/pg.json': userRoute([5]),
      '/v0/item/5.json': itemRoute({ 5: { id: 5, type: 'story', by: 'pg', title: 'Back online' } }),
    });
    openServers.push(closeAgain);

    await refreshHackernewsAuthorSource(db, created.source.id, { fetchImpl: fetchAgainst(origin) });
    const [refreshed] = await listProjectSources(db, orgId, projectId);
    expect(refreshed.fetchError).toBeNull();
    expect(outputText(refreshed.output)).toContain('Back online');
  });

  it('is a no-op for a row that is not a hackernews_author source', async () => {
    const { orgId, projectId } = await setupOrgAndProject();
    const db = getDb();
    const [row] = await db
      .insert(schema.projectSources)
      .values({ projectId, kind: 'folder', config: { value: '/tmp/a' } })
      .returning();

    await expect(refreshHackernewsAuthorSource(db, row!.id)).resolves.toBeUndefined();
    const [after] = await listProjectSources(db, orgId, projectId);
    expect(after.fetchError).toBeNull();
    expect(after.fetchedAt).toBeNull();
  });
});

/** Re-binds a fixture server to a specific already-freed port, for the
 * "unreachable, then comes back" refresh test above. */
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
