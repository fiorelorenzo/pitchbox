import { json, error } from '@sveltejs/kit';
import { randomBytes, createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { loadSession } from '@pitchbox/shared/auth';
import { loadActiveOrganization } from '@pitchbox/shared/orgs';
import { getDb, schema } from '$lib/server/db.js';

/**
 * One-shot pairing endpoint for the browser extension.
 *
 * The extension's auto-pair content script runs inside the dashboard origin
 * (cloud or self-hosted), so this fetch carries the user's session cookie
 * automatically. We mint a fresh device token tied to the resolved org and
 * return it. The client persists the token in `chrome.storage.local`.
 *
 * Auth modes:
 *  - PITCHBOX_AUTH=on: requires a valid session cookie. Token is bound to the
 *    caller's active org.
 *  - PITCHBOX_AUTH off: single-user mode. Anyone with access to the dashboard
 *    origin already passed whatever boundary the operator set up (LAN /
 *    Tailscale / reverse proxy), so we bind the token to the default org.
 *
 * The endpoint lives under /api/extension/* which is exempt from cookie auth
 * by hooks.server.ts; we re-implement the session check here so we can fall
 * through cleanly when auth is off.
 */
const SESSION_COOKIE = 'pitchbox_session';
const AUTH_ON = process.env.PITCHBOX_AUTH === 'on';

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

async function defaultOrgId(db: ReturnType<typeof getDb>): Promise<number | null> {
  const [row] = await db
    .select({ id: schema.organizations.id })
    .from(schema.organizations)
    .where(eq(schema.organizations.slug, 'default'))
    .limit(1);
  return row?.id ?? null;
}

export async function GET({
  cookies,
  request,
}: {
  cookies: import('@sveltejs/kit').Cookies;
  request: Request;
}) {
  const db = getDb();

  let organizationId: number | null;

  if (AUTH_ON) {
    const cookie = cookies.get(SESSION_COOKIE);
    const session = cookie ? await loadSession(db, cookie) : null;
    if (!session) throw error(401, 'unauthenticated');
    // Honor the session's active org (switchable via the org switcher), not
    // just the user's first membership - loadOrganizationForUser ignores
    // activeOrganizationId entirely.
    const org = await loadActiveOrganization(
      db,
      session.userId,
      session.activeOrganizationId ?? null,
    );
    organizationId = org?.id ?? (await defaultOrgId(db));
  } else {
    organizationId = await defaultOrgId(db);
  }

  if (!organizationId) throw error(500, 'no_org');

  // #200: the client wants to show which org/device a pairing belongs to,
  // not just a bare token - look up the org name alongside minting the
  // device row.
  const [org] = await db
    .select({ name: schema.organizations.name })
    .from(schema.organizations)
    .where(eq(schema.organizations.id, organizationId))
    .limit(1);

  const token = randomBytes(32).toString('hex');
  const tokenHash = hashToken(token);
  const userAgent = request.headers.get('user-agent') ?? '';
  const label = `Browser extension${userAgent ? ` (${userAgent.slice(0, 80)})` : ''}`;
  const [row] = await db
    .insert(schema.extensionDevices)
    .values({ organizationId, label, tokenHash })
    .returning({ id: schema.extensionDevices.id });

  return json({ token, deviceId: row.id, orgName: org?.name ?? null, deviceLabel: label });
}
