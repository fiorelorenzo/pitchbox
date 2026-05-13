import { getDb, schema } from '$lib/server/db.js';
import { eq } from 'drizzle-orm';
import { loadSession, loadOrganizationForUser } from '@pitchbox/shared/auth';

/**
 * One-shot cleanup on server boot.
 *
 * The `runs` table stores an in-flight run as `status='running'`, and the
 * runner keeps the cancel handle in an in-memory map. If the dev server
 * restarts (HMR, crash, manual stop) that map is lost but the DB row is
 * left stuck as running forever. On boot we mark any such orphans as
 * failed so the UI doesn't show phantom "Running" states.
 */
async function reapOrphanedRuns() {
  try {
    const db = getDb();
    const now = new Date();
    const result = await db
      .update(schema.runs)
      .set({
        status: 'failed',
        finishedAt: now,
        error: 'orphaned by server restart',
      })
      .where(eq(schema.runs.status, 'running'))
      .returning({ id: schema.runs.id });
    if (result.length > 0) {
      console.log(
        `[hooks] reaped ${result.length} orphaned run(s):`,
        result.map((r) => r.id),
      );
    }
  } catch (err) {
    console.error('[hooks] failed to reap orphaned runs:', err);
  }
}

// Run once at module load (first request to the server).
await reapOrphanedRuns();

/**
 * Optional embedded daemon: when PITCHBOX_EMBED_DAEMON=1 the same loops the
 * standalone `pitchbox daemon` process runs are started in-proc here. Useful
 * for single-host self-hosters who don't want a second supervised process.
 *
 * The advisory lock around dispatch (#32) and `SELECT … FOR UPDATE SKIP LOCKED`
 * on webhook deliveries (#36) keep behaviour consistent even if a standalone
 * daemon is also running against the same DB. Heartbeat module is tagged 'web'
 * so the Settings page can tell which process supplies liveness.
 */
if (process.env.PITCHBOX_EMBED_DAEMON === '1') {
  const { startEmbeddedDaemon } = await import('@pitchbox/daemon/embed');
  const daemon = startEmbeddedDaemon({ heartbeatModule: 'web' });
  const stop = async (sig: string) => {
    console.log(`[hooks] ${sig} - stopping embedded daemon`);
    await daemon.stop();
  };
  process.once('SIGINT', () => void stop('SIGINT'));
  process.once('SIGTERM', () => void stop('SIGTERM'));
}

const EXTENSION_ALLOWED_ORIGINS = new Set(['https://www.reddit.com', 'https://old.reddit.com']);

function extensionCorsHeaders(origin: string | null): Record<string, string> {
  const allowed = origin && EXTENSION_ALLOWED_ORIGINS.has(origin) ? origin : 'null';
  return {
    'access-control-allow-origin': allowed,
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'authorization, content-type',
    'access-control-max-age': '86400',
    vary: 'Origin',
  };
}

const AUTH_ON = process.env.PITCHBOX_AUTH === 'on';
const SESSION_COOKIE = 'pitchbox_session';
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function isExemptPath(pathname: string): boolean {
  return (
    pathname.startsWith('/api/extension/') ||
    pathname.startsWith('/login') ||
    pathname.startsWith('/api/auth/') ||
    pathname.startsWith('/_app/') ||
    pathname.startsWith('/favicon')
  );
}

/**
 * Reject cross-origin mutations to /api/* (except extension routes which
 * have their own bearer-token auth and explicit allowed origins). Same-origin
 * dashboard fetches pass through unchanged. This is the lightweight CSRF
 * defence - we don't need a per-request token because every state-changing
 * route is fetch-only (no plain HTML forms).
 */
function blocksCrossOriginMutation(event: { request: Request; url: URL }): boolean {
  if (!event.url.pathname.startsWith('/api/')) return false;
  if (event.url.pathname.startsWith('/api/extension/')) return false;
  if (!MUTATING_METHODS.has(event.request.method)) return false;
  const origin = event.request.headers.get('origin');
  if (!origin) return false;
  let originUrl: URL;
  try {
    originUrl = new URL(origin);
  } catch {
    return true;
  }
  return originUrl.host !== event.url.host;
}

export const handle = async ({ event, resolve }) => {
  const isExtensionRoute = event.url.pathname.startsWith('/api/extension/');

  if (isExtensionRoute && event.request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: extensionCorsHeaders(event.request.headers.get('origin')),
    });
  }

  if (blocksCrossOriginMutation(event)) {
    return new Response(JSON.stringify({ error: 'cross_origin_blocked' }), {
      status: 403,
      headers: { 'content-type': 'application/json' },
    });
  }

  if (AUTH_ON && !isExemptPath(event.url.pathname)) {
    const cookie = event.cookies.get(SESSION_COOKIE);
    const session = cookie ? await loadSession(getDb(), cookie) : null;
    if (!session) {
      const next = encodeURIComponent(event.url.pathname + event.url.search);
      // API callers get a 401 so they can react; HTML navigations get a redirect.
      const wantsJson = event.request.headers.get('accept')?.includes('application/json');
      if (event.url.pathname.startsWith('/api/') || wantsJson) {
        return new Response(JSON.stringify({ error: 'unauthenticated' }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(null, { status: 302, headers: { location: `/login?next=${next}` } });
    }
    event.locals.user = { id: session.userId, username: session.username };

    // Resolve active organization. Multi-tenant phase 2: every authenticated
    // request must map to a membership. If the user has none, return 404 to
    // avoid leaking the existence of unrelated orgs. The `/invite/*` and
    // `/api/orgs/*/invites/*/accept` routes are exempt - a brand-new user
    // accepting an invite has no membership yet.
    const path = event.url.pathname;
    const orgExempt = path.startsWith('/invite/') || path.startsWith('/api/orgs/');
    const org = await loadOrganizationForUser(getDb(), session.userId);
    if (org) {
      event.locals.org = org;
    } else if (!orgExempt) {
      if (event.url.pathname.startsWith('/api/')) {
        return new Response(JSON.stringify({ error: 'not_found' }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('Not Found', { status: 404 });
    }
  }

  const response = await resolve(event);

  if (isExtensionRoute) {
    const headers = extensionCorsHeaders(event.request.headers.get('origin'));
    for (const [k, v] of Object.entries(headers)) response.headers.set(k, v);
  }

  return response;
};
