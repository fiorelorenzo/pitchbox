// Exercises shared/src/website-source.ts: a `website` project_sources kind
// whose text is fetched and refreshed on demand (#433). Covers the robots.txt
// parser and the crawl's caps against real served fixtures (a local HTTP
// server, not a mocked fetch) - a disallow, a huge page, a redirect and an
// unreachable host are all real network behaviour, not something a parser
// unit test alone would catch - plus the `project_sources` wiring
// (`addWebsiteSource` / `refreshWebsiteSource`) and its failure isolation.
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb, getPool, schema } from '../src/db/client.js';
import { listProjectSources } from '../src/project-sources.js';
import {
  addWebsiteSource,
  crawlWebsite,
  extractPageText,
  extractSameHostLinks,
  parseRobotsTxt,
  refreshWebsiteSource,
  WEBSITE_MAX_PAGES,
} from '../src/website-source.js';

// ---- Fixture server -------------------------------------------------------

type RouteHandler = (req: IncomingMessage, res: ServerResponse) => void;

/** Starts a throwaway HTTP server for one test, routed by exact pathname. */
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

const openServers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (openServers.length > 0) await openServers.pop()!();
});

function html(body: string): string {
  return `<!doctype html><html><body>${body}</body></html>`;
}

// ---- parseRobotsTxt --------------------------------------------------------

describe('parseRobotsTxt', () => {
  it('disallows a path listed under the matching group', () => {
    const rules = parseRobotsTxt('User-agent: *\nDisallow: /private\n', 'PitchboxBot/1.0');
    expect(rules.isAllowed('/private/page')).toBe(false);
    expect(rules.isAllowed('/public')).toBe(true);
  });

  it('lets the longest matching rule win between an Allow and a Disallow', () => {
    const rules = parseRobotsTxt('User-agent: *\nDisallow: /docs\nAllow: /docs/public\n', '*');
    expect(rules.isAllowed('/docs/secret')).toBe(false);
    expect(rules.isAllowed('/docs/public/page')).toBe(true);
  });

  it('allows everything when the file has no matching group', () => {
    const rules = parseRobotsTxt('User-agent: SomeOtherBot\nDisallow: /\n', 'PitchboxBot/1.0');
    expect(rules.isAllowed('/anything')).toBe(true);
  });

  it('allows everything for an empty file', () => {
    expect(parseRobotsTxt('', 'PitchboxBot/1.0').isAllowed('/x')).toBe(true);
  });
});

// ---- extractSameHostLinks ---------------------------------------------------

describe('extractSameHostLinks', () => {
  it('keeps only same-host http(s) links, resolved and deduplicated', () => {
    const page = html(`
      <a href="/docs">Docs</a>
      <a href="/docs">Docs again</a>
      <a href="https://other-host.example/x">Off-host</a>
      <a href="#section">Anchor only</a>
      <a href="mailto:hi@example.com">Mail</a>
      <a href="https://example.com/">Root again</a>
    `);
    const links = extractSameHostLinks(page, 'https://example.com/');
    expect(links).toEqual(['https://example.com/docs']);
  });
});

// ---- extractPageText --------------------------------------------------------

describe('extractPageText', () => {
  it('keeps heading and paragraph text, drops script/style/img', () => {
    const text = extractPageText(
      '<html><head><style>.x{color:red}</style></head><body>' +
        '<script>doSomethingEvil();</script>' +
        '<h1>Welcome</h1><p>Readable sentence.</p><img src="x.png" alt="pic"/>' +
        '</body></html>',
    );
    expect(text).toContain('WELCOME');
    expect(text).toContain('Readable sentence.');
    expect(text).not.toContain('doSomethingEvil');
    expect(text).not.toContain('color:red');
  });
});

// ---- crawlWebsite against real fixture servers -----------------------------

describe('crawlWebsite', () => {
  it('fetches the root page and extracts readable text', async () => {
    const { origin, close } = await startFixtureServer({
      '/': (_req, res) =>
        res
          .writeHead(200, { 'content-type': 'text/html' })
          .end(html('<h1>Hello</h1><p>World.</p>')),
    });
    openServers.push(close);

    const result = await crawlWebsite(origin + '/');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pages).toHaveLength(1);
    expect(result.pages[0]!.text).toContain('HELLO');
    expect(result.pages[0]!.text).toContain('World.');
  });

  it('honours a robots.txt disallow against a served fixture, refusing the page', async () => {
    const { origin, close } = await startFixtureServer({
      '/robots.txt': (_req, res) =>
        res.writeHead(200, { 'content-type': 'text/plain' }).end('User-agent: *\nDisallow: /\n'),
      '/': (_req, res) =>
        res
          .writeHead(200, { 'content-type': 'text/html' })
          .end(html('<p>Should never be read.</p>')),
    });
    openServers.push(close);

    const result = await crawlWebsite(origin + '/');
    expect(result).toEqual({ ok: false, reason: 'robots.txt disallows fetching this page' });
  });

  it('still fetches an allowed page when robots.txt disallows a different path', async () => {
    const { origin, close } = await startFixtureServer({
      '/robots.txt': (_req, res) =>
        res
          .writeHead(200, { 'content-type': 'text/plain' })
          .end('User-agent: *\nDisallow: /private\n'),
      '/': (_req, res) =>
        res.writeHead(200, { 'content-type': 'text/html' }).end(html('<p>Public page.</p>')),
    });
    openServers.push(close);

    const result = await crawlWebsite(origin + '/');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.pages[0]!.text).toContain('Public page.');
  });

  it('crawls same-host linked pages up to the cap when crawlLinks is set', async () => {
    const pageCount = WEBSITE_MAX_PAGES + 5;
    const servePage: RouteHandler = (req, res) => {
      const i = Number(new URL(req.url ?? '/', 'http://localhost').pathname.replace('/page', ''));
      res.writeHead(200, { 'content-type': 'text/html' }).end(html(`<p>Page ${i} body.</p>`));
    };
    const routes: Record<string, RouteHandler> = {
      '/': (_req, res) =>
        res
          .writeHead(200, { 'content-type': 'text/html' })
          .end(
            html(
              Array.from({ length: pageCount }, (_, i) => `<a href="/page${i}">p${i}</a>`).join(''),
            ),
          ),
    };
    for (let i = 0; i < pageCount; i++) routes[`/page${i}`] = servePage;
    const { origin, close } = await startFixtureServer(routes);
    openServers.push(close);

    const result = await crawlWebsite(origin + '/', { crawlLinks: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Root plus linked pages, never more than the small cap.
    expect(result.pages.length).toBe(WEBSITE_MAX_PAGES);
  });

  it('does not follow a cross-host link even with crawlLinks set', async () => {
    const { origin, close } = await startFixtureServer({
      '/': (_req, res) =>
        res
          .writeHead(200, { 'content-type': 'text/html' })
          .end(html('<a href="https://not-this-host.example/x">off</a>')),
    });
    openServers.push(close);

    const result = await crawlWebsite(origin + '/', { crawlLinks: true });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.pages).toHaveLength(1);
  });

  it('caps a deliberately huge page at the byte limit instead of buffering it whole', async () => {
    const { origin, close } = await startFixtureServer({
      '/': (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/html' });
        // 20MB of filler, far past any reasonable page cap - written in
        // chunks so the server itself never buffers it all either.
        const chunk = '<p>' + 'x'.repeat(64 * 1024) + '</p>';
        let written = 0;
        const target = 20 * 1024 * 1024;
        const pump = () => {
          while (written < target) {
            if (!res.write(chunk)) {
              res.once('drain', pump);
              return;
            }
            written += chunk.length;
          }
          res.end();
        };
        pump();
      },
    });
    openServers.push(close);

    const maxBytesPerPage = 50_000;
    const result = await crawlWebsite(origin + '/', { maxBytesPerPage, timeoutMs: 15_000 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pages[0]!.bytes).toBeLessThanOrEqual(maxBytesPerPage);
    expect(result.pages[0]!.truncated).toBe(true);
  }, 20_000);

  it('follows a redirect to a same-host page and extracts its text', async () => {
    const { origin, close } = await startFixtureServer({
      '/': (_req, res) => res.writeHead(302, { location: '/final' }).end(),
      '/final': (_req, res) =>
        res.writeHead(200, { 'content-type': 'text/html' }).end(html('<p>Landed here.</p>')),
    });
    openServers.push(close);

    const result = await crawlWebsite(origin + '/');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.pages[0]!.text).toContain('Landed here.');
  });

  it('fails with a network-error reason for an unreachable host, never throwing', async () => {
    // Nothing listens on this port (a server started then immediately
    // closed) - a real connection-refused, not a mocked failure.
    const { origin, close } = await startFixtureServer({});
    await close();

    const result = await crawlWebsite(origin + '/');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/network error/);
  });

  it('times out a page that never finishes responding, within the given budget', async () => {
    const { origin, close } = await startFixtureServer({
      '/': (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.write('<p>start...');
        // Never calls res.end() - the connection just hangs.
      },
    });
    openServers.push(close);

    const result = await crawlWebsite(origin + '/', { timeoutMs: 200 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/timed out/);
  }, 5_000);

  it('rejects an invalid URL without making a request', async () => {
    const result = await crawlWebsite('not a url');
    expect(result).toEqual({ ok: false, reason: 'invalid URL' });
  });
});

// ---- addWebsiteSource / refreshWebsiteSource (DB-backed) -------------------

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
  const slug = `website-source-test-${randomUUID()}`;
  const [org] = await db.insert(schema.organizations).values({ slug, name: slug }).returning();
  createdOrgIds.push(org.id);
  const [project] = await db
    .insert(schema.projects)
    .values({ organizationId: org.id, slug: 'p', name: 'P' })
    .returning();
  return { orgId: org.id, projectId: project.id };
}

/** Narrows a source row's `output` jsonb down to its `text` field, for
 * assertions - a type guard rather than an inline cast, since `output` is
 * `unknown` at the schema level. */
function outputText(output: unknown): string {
  if (
    !output ||
    typeof output !== 'object' ||
    !('text' in output) ||
    typeof output.text !== 'string'
  ) {
    throw new Error('expected a website source output carrying text');
  }
  return output.text;
}

describe('addWebsiteSource', () => {
  it('creates a website source and fetches it inline', async () => {
    const { origin, close } = await startFixtureServer({
      '/': (_req, res) =>
        res
          .writeHead(200, { 'content-type': 'text/html' })
          .end(html('<h1>Acme</h1><p>We make widgets.</p>')),
    });
    openServers.push(close);
    const { orgId, projectId } = await setupOrgAndProject();
    const db = getDb();

    const result = await addWebsiteSource(db, orgId, projectId, origin + '/');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.source.kind).toBe('website');
    expect(result.source.fetchError).toBeNull();
    expect(result.source.fetchedAt).not.toBeNull();
    expect(outputText(result.source.output)).toContain('We make widgets.');
  });

  it('rejects a non-http(s) URL without creating a row', async () => {
    const { orgId, projectId } = await setupOrgAndProject();
    const db = getDb();

    const result = await addWebsiteSource(db, orgId, projectId, 'ftp://example.com/file');
    expect(result).toEqual({
      ok: false,
      code: 'invalid_url',
      reason: 'only http(s) URLs are supported',
    });
    expect(await listProjectSources(db, orgId, projectId)).toEqual([]);
  });

  it('does not create a source for a project in a different organization', async () => {
    const { projectId } = await setupOrgAndProject();
    const { orgId: otherOrgId } = await setupOrgAndProject();
    const db = getDb();

    const result = await addWebsiteSource(db, otherOrgId, projectId, 'https://example.com');
    expect(result).toEqual({ ok: false, code: 'not_found' });
  });

  it('an unreachable host fails only its own source, leaving the project (and its other sources) readable', async () => {
    const { orgId, projectId } = await setupOrgAndProject();
    const db = getDb();

    // A working source already on the project, to prove it survives.
    const { origin: goodOrigin, close } = await startFixtureServer({
      '/': (_req, res) =>
        res.writeHead(200, { 'content-type': 'text/html' }).end(html('<p>I still work.</p>')),
    });
    openServers.push(close);
    const good = await addWebsiteSource(db, orgId, projectId, goodOrigin + '/');
    expect(good.ok).toBe(true);

    const { origin: deadOrigin, close: closeDead } = await startFixtureServer({});
    await closeDead(); // nothing listens here

    const failed = await addWebsiteSource(db, orgId, projectId, deadOrigin + '/');
    expect(failed.ok).toBe(true); // the row is created; only its own fetch fails
    if (failed.ok) {
      expect(failed.source.fetchError).toMatch(/network error/);
      expect(failed.source.output).toBeNull();
    }

    // The project's source list is still readable, including both rows.
    const sources = await listProjectSources(db, orgId, projectId);
    expect(sources).toHaveLength(2);
    const stillGood = sources.find((s) => s.id === (good.ok ? good.source.id : -1));
    expect(stillGood?.fetchError).toBeNull();
    expect(outputText(stillGood?.output)).toContain('I still work.');
  });
});

describe('refreshWebsiteSource', () => {
  it('re-fetches in place, clearing a previous fetch_error on success', async () => {
    const { orgId, projectId } = await setupOrgAndProject();
    const db = getDb();

    const { origin, close } = await startFixtureServer({});
    await close(); // starts unreachable
    const created = await addWebsiteSource(db, orgId, projectId, origin + '/');
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.source.fetchError).not.toBeNull();

    // Bring the same origin back up and refresh the same row.
    const { close: closeAgain } = await startFixtureServerOnPort(new URL(origin).port, {
      '/': (_req, res) =>
        res.writeHead(200, { 'content-type': 'text/html' }).end(html('<p>Back online.</p>')),
    });
    openServers.push(closeAgain);

    await refreshWebsiteSource(db, created.source.id);
    const [refreshed] = await listProjectSources(db, orgId, projectId);
    expect(refreshed.fetchError).toBeNull();
    expect(outputText(refreshed.output)).toContain('Back online.');
  });

  it('is a no-op for a row that is not a website source', async () => {
    const { orgId, projectId } = await setupOrgAndProject();
    const db = getDb();
    const [row] = await db
      .insert(schema.projectSources)
      .values({ projectId, kind: 'folder', config: { value: '/tmp/a' } })
      .returning();

    await expect(refreshWebsiteSource(db, row!.id)).resolves.toBeUndefined();
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
