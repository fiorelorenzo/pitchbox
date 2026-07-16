import { json, error, type RequestEvent } from '@sveltejs/kit';
import { loadSession } from '@pitchbox/shared/auth';
import { getDb } from '../../../../lib/server/db.js';
import { requireRole } from '../../../../lib/server/auth.js';
import { listRecentAuthFailures } from '@pitchbox/shared/auth';

const COOKIE = 'pitchbox_session';

// hooks.server.ts already enforces a valid session (and resolves
// `event.locals.org` for `requireRole` below) for this route - only
// `/api/auth/login` and `/api/auth/logout` are exempt from that check (#132).
// This is a cheap defense-in-depth re-check, not the primary guard.
async function requireSession(event: RequestEvent): Promise<void> {
  if (process.env.PITCHBOX_AUTH !== 'on') return;
  const token = event.cookies.get(COOKIE);
  const session = token ? await loadSession(getDb(), token) : null;
  if (!session) throw error(401, 'unauthenticated');
}

// Surface the last 50 failed login attempts to the Security settings page.
export async function GET(event: RequestEvent) {
  await requireSession(event);
  requireRole(event, 'admin'); // the failed-login list is admin-only
  const rows = await listRecentAuthFailures(getDb(), 50);
  return json({
    failures: rows.map((r) => ({
      id: r.id,
      identifier: r.identifier,
      failedAt: r.failedAt.toISOString(),
      kind: r.kind,
    })),
  });
}
