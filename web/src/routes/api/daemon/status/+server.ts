import { json, type RequestEvent } from '@sveltejs/kit';
import { getDb, schema } from '$lib/server/db.js';
import { requireInstanceAdmin } from '$lib/server/auth.js';
import { isCloud } from '@pitchbox/shared/edition';

/** Daemon is considered "alive" if we've seen a heartbeat in the last STALE_MS. */
const STALE_MS = 2 * 60 * 1000;

// The signed-in floor already comes from hooks.server.ts (this path is not
// in `isExemptPath`, so an unauthenticated request never reaches here when
// PITCHBOX_AUTH=on). On cloud there is one daemon shared by every tenant, so
// its liveness and module list describe the deployment, not any one org's
// data - instance-wide information the same way default-runner/quota/
// webhooks are (docs/permissions.md "Instance admin"), gated here rather
// than left to the hook so the boundary survives a future change to the
// exemption list. `requireInstanceAdmin` is a no-op when auth is off, so
// single-user self-host - where this is the operator's own dashboard - keeps
// the full access it always had.
export async function GET(event: RequestEvent) {
  if (isCloud()) {
    await requireInstanceAdmin(event);
  }
  const db = getDb();
  const rows = await db.select().from(schema.daemonHeartbeats);
  const now = Date.now();

  const modules = rows.map((r) => {
    const tickMs = new Date(r.tickAt).getTime();
    return {
      module: r.module,
      tickAt: r.tickAt,
      ageSeconds: Math.round((now - tickMs) / 1000),
      alive: now - tickMs < STALE_MS,
    };
  });

  // Either the standalone `pitchbox daemon` process (module='daemon') or the
  // web's embedded loops (module='web', when PITCHBOX_EMBED_DAEMON=1) count.
  const alive = modules.some((m) => (m.module === 'daemon' || m.module === 'web') && m.alive);

  return json({ alive, modules });
}
