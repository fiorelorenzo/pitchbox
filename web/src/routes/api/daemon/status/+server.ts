import { json } from '@sveltejs/kit';
import { getDb, schema } from '$lib/server/db.js';

/** Daemon is considered "alive" if we've seen a heartbeat in the last STALE_MS. */
const STALE_MS = 2 * 60 * 1000;

export async function GET() {
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

  const alive = modules.some((m) => m.module === 'daemon' && m.alive);

  return json({ alive, modules });
}
