import { timingSafeEqual } from 'node:crypto';
import { getDb, schema } from '$lib/server/db.js';
import { eq } from 'drizzle-orm';
import { loadSession } from '@pitchbox/shared/auth';
import { loadActiveOrganization } from '@pitchbox/shared/orgs';
import { extensionCorsHeaders } from '$lib/server/extension-cors.js';
import { trustedOriginSet } from '$lib/trusted-origins.js';
import { LOCALE_COOKIE, resolveLocale, type Locale } from '$lib/i18n.js';

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

const AUTH_ON = process.env.PITCHBOX_AUTH === 'on';
const SESSION_COOKIE = 'pitchbox_session';
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * The daemon dispatches a scheduled or keyword-triggered campaign by POSTing
 * this web app's own /api/run from its own process (`daemon/src/scheduler.ts`,
 * `daemon/src/keyword-watcher.ts`), which carries no browser session and
 * never will. Before #378 that made every such dispatch a 401 under
 * PITCHBOX_AUTH=on, and the campaign's own failure backoff eventually paused
 * it, recording the reason as failed dispatches rather than an auth
 * misconfiguration.
 *
 * PITCHBOX_INTERNAL_TOKEN is a secret of its own, never reused from
 * ENCRYPTION_KEY or any other secret. It is accepted only for POST /api/run,
 * only on a request that carries no session, and only when the secret is
 * configured - an unset secret leaves the route exactly as closed as it is
 * today, since `safeTokenEquals`'s length guard means no supplied value can
 * ever match an empty configured secret, and `isInternalDispatchRequest`
 * bails out before comparing anything when INTERNAL_TOKEN is empty.
 */
const INTERNAL_TOKEN = process.env.PITCHBOX_INTERNAL_TOKEN ?? '';
const INTERNAL_DISPATCH_PATH = '/api/run';

// Constant-time comparison so a wrong token can't be distinguished from a
// right one by response timing - this guards an auth boundary.
function safeTokenEquals(supplied: string, expected: string): boolean {
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function isInternalDispatchRequest(event: { request: Request; url: URL }): boolean {
  if (event.url.pathname !== INTERNAL_DISPATCH_PATH) return false;
  if (!INTERNAL_TOKEN) return false;
  const header = event.request.headers.get('authorization') ?? '';
  const match = /^Bearer\s+(.+)$/.exec(header);
  if (!match) return false;
  return safeTokenEquals(match[1], INTERNAL_TOKEN);
}

function isExemptPath(pathname: string): boolean {
  return (
    pathname.startsWith('/api/extension/') ||
    // The Stripe webhook (#551) is a signed, unauthenticated-by-cookie
    // delivery from Stripe's own servers - it verifies `Stripe-Signature`
    // itself (shared/src/stripe/signature.ts) instead of a session, and
    // must be reachable with auth on or off since the signing secret, not
    // a Pitchbox account, is the boundary.
    pathname.startsWith('/api/stripe/webhook') ||
    pathname.startsWith('/login') ||
    // A visitor with no session has to be able to reach both halves of
    // sign-up too (#504): /register itself, and /invite/<token>'s own
    // redirect there for someone with no account yet. `/api/auth/unlock`
    // and `/api/auth/failures` stay OUT of this list on purpose - they are
    // admin-only management endpoints and must go through the same
    // session + org/role resolution as every other /api/* route below, or
    // `requireRole` in those handlers has nothing to gate on (#132).
    pathname.startsWith('/register') ||
    pathname.startsWith('/api/auth/login') ||
    pathname.startsWith('/api/auth/logout') ||
    pathname.startsWith('/api/auth/register') ||
    // Forgot/reset password (#509): a locked-out visitor has no session by
    // definition, so the request page (`/reset`), the confirm page
    // (`/reset/<token>`), and both API endpoints all need to be reachable
    // session-less. Exact prefixes, same as the entries above - not a
    // blanket `/api/auth/password`, which would also exempt the signed-in
    // self-service change at POST /api/auth/password
    // (web/src/routes/api/auth/password/+server.ts) that must stay behind
    // session resolution.
    pathname.startsWith('/reset') ||
    pathname.startsWith('/api/auth/password/forgot') ||
    pathname.startsWith('/api/auth/password/reset') ||
    // Email verification (#514): the link may be opened with no session at
    // all (a different device, or the browser that registered having since
    // signed out), so the confirm page and its API need to be reachable
    // session-less too. Exact prefix again - not a blanket `/api/auth/
    // verify`, which would also exempt POST /api/auth/verify/resend, a
    // self-service action that must stay behind session resolution the
    // same way POST /api/auth/password does.
    pathname.startsWith('/verify') ||
    pathname.startsWith('/api/auth/verify/confirm') ||
    pathname.startsWith('/_app/') ||
    pathname.startsWith('/favicon')
  );
}

const TRUSTED_ORIGIN_SET = trustedOriginSet();

/**
 * Reject cross-origin mutations to /api/* (except extension routes which
 * have their own bearer-token auth and explicit allowed origins). Same-origin
 * dashboard fetches pass through unchanged. This is the lightweight CSRF
 * defence - we don't need a per-request token because every state-changing
 * route is fetch-only (no plain HTML forms).
 *
 * `event.url` is built from adapter-node's ORIGIN, not from the request's
 * Host header, so "same origin" here means "the origin this deployment says
 * it serves" and every other host answered by the same server looks
 * cross-site. That is why the same allowlist SvelteKit's own form check gets
 * (`csrf.trustedOrigins`) has to apply here too: without it, moving ORIGIN
 * to app.pitchbox.app turned every mutation from a browser still on the
 * apex into a 403 nothing explained (#501).
 */
function blocksCrossOriginMutation(event: { request: Request; url: URL }): boolean {
  if (!event.url.pathname.startsWith('/api/')) return false;
  if (event.url.pathname.startsWith('/api/extension/')) return false;
  // Same reasoning as `isExemptPath` above: Stripe never sends an `Origin`
  // header a browser would, but explicit beats "happens to fall through".
  if (event.url.pathname.startsWith('/api/stripe/webhook')) return false;
  if (!MUTATING_METHODS.has(event.request.method)) return false;
  const origin = event.request.headers.get('origin');
  if (!origin) return false;
  let originUrl: URL;
  try {
    originUrl = new URL(origin);
  } catch {
    return true;
  }
  if (originUrl.host === event.url.host) return false;
  return !TRUSTED_ORIGIN_SET.has(originUrl.origin);
}

/**
 * `event.locals.locale` (LOR-260), computed once per request rather than
 * per loader so no two loaders/components can resolve it differently. No
 * `accountLocale` source exists yet - LOR-262 adds the column and reads it
 * from `event.locals.user`'s session; the call site below is exactly where
 * that value plugs in, and this precedence itself does not change.
 */
function requestLocale(
  event: { cookies: { get(name: string): string | undefined }; request: Request },
  accountLocale?: Locale | null,
): Locale {
  return resolveLocale({
    accountLocale,
    cookieLocale: event.cookies.get(LOCALE_COOKIE),
    acceptLanguageHeader: event.request.headers.get('accept-language'),
  });
}

export const handle = async ({ event, resolve }) => {
  // Resolved before every other branch: an early-return response (CORS
  // preflight, a cross-origin block, an unauthenticated 401/302) never
  // reaches SvelteKit's own renderer and needs no locale, but every path
  // that does render a page reads the same `event.locals.locale` from here
  // rather than deciding again. See `requestLocale` above for the LOR-262
  // attach point (the account-preference input, currently always absent).
  event.locals.locale = requestLocale(event);

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
      if (!isInternalDispatchRequest(event)) {
        const next = encodeURIComponent(event.url.pathname + event.url.search);
        // API callers get a 401 so they can react; HTML navigations get a redirect.
        const wantsJson = event.request.headers.get('accept')?.includes('application/json');
        if (event.url.pathname.startsWith('/api/') || wantsJson) {
          return new Response(JSON.stringify({ error: 'unauthenticated' }), {
            status: 401,
            headers: { 'content-type': 'application/json' },
          });
        }
        // An invite link is an account nobody has yet (#504) - send a
        // session-less visitor to create one, not to a login form for a
        // user that doesn't exist. Every other route still goes to /login.
        const base = event.url.pathname.startsWith('/invite/') ? '/register' : '/login';
        return new Response(null, { status: 302, headers: { location: `${base}?next=${next}` } });
      }
      // Verified internal dispatch to /api/run (see INTERNAL_TOKEN above):
      // fall through with no locals.user / locals.org, same as the
      // AUTH_ON=off self-host path. The route handler already treats a
      // request with no locals.org as the daemon's own dispatch caller
      // (web/src/routes/api/run/+server.ts).
    } else {
      event.locals.user = { id: session.userId, username: session.username };
      // LOR-262 attaches here: once `session` carries a stored locale
      // preference, re-run `requestLocale(event, session.locale)` and
      // reassign `event.locals.locale` so the account setting outranks the
      // cookie for a signed-in request. `resolveLocale`'s precedence does
      // not change; only this call's second argument does.

      // Resolve active organization. Multi-tenant phase 2: every authenticated
      // request must map to a membership. If the user has none, return 404 to
      // avoid leaking the existence of unrelated orgs. The `/invite/*` and
      // `/api/orgs/*/invites/*/accept` routes are exempt - a brand-new user
      // accepting an invite has no membership yet.
      const path = event.url.pathname;
      const orgExempt = path.startsWith('/invite/') || path.startsWith('/api/orgs/');
      const org = await loadActiveOrganization(
        getDb(),
        session.userId,
        session.activeOrganizationId ?? null,
      );
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
  }

  const response = await resolve(event, {
    transformPageChunk: ({ html }) => html.replace('lang="en"', `lang="${event.locals.locale}"`),
  });

  if (isExtensionRoute) {
    const headers = extensionCorsHeaders(event.request.headers.get('origin'));
    for (const [k, v] of Object.entries(headers)) response.headers.set(k, v);
  }

  return response;
};
