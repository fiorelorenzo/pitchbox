import { json, error, type RequestEvent } from '@sveltejs/kit';
import { loadSession } from '@pitchbox/shared/auth';
import { getDb } from '../../../../lib/server/db.js';
import { listRecentAuthFailures } from '@pitchbox/shared/auth';

const COOKIE = 'pitchbox_session';

// `/api/auth/*` is exempt from the hooks auth check (so login/logout work
// without a session). For management endpoints under that prefix we therefore
// have to verify the session ourselves.
async function requireSession(event: RequestEvent): Promise<void> {
  if (process.env.PITCHBOX_AUTH !== 'on') return;
  const token = event.cookies.get(COOKIE);
  const session = token ? await loadSession(getDb(), token) : null;
  if (!session) throw error(401, 'unauthenticated');
}

// Surface the last 50 failed login attempts to the Security settings page.
export async function GET(event: RequestEvent) {
  await requireSession(event);
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
