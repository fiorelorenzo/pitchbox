import type { PageServerLoad } from './$types';
import { getDb } from '$lib/server/db.js';
import { requireInstanceAdmin } from '$lib/server/auth.js';
import { loadInstanceAuditLog } from '@pitchbox/shared/instance-audit';

// Instance-wide config audit trail (#414), inside the area #412 built. The
// area's `+layout.server.ts` already gates the whole subtree, and this
// loader gates itself again - same reason models/+page.server.ts does: the
// write path next door does the same, and the loader is the boundary that
// holds when somebody types the URL rather than following a link that was
// hidden from them.
export const load: PageServerLoad = async (event) => {
  await requireInstanceAdmin(event);
  const rows = await loadInstanceAuditLog(getDb());
  return {
    rows: rows.map((r) => ({
      id: r.id,
      key: r.key,
      actor: r.actor,
      before: r.before,
      after: r.after,
      createdAt: r.createdAt.toISOString(),
    })),
  };
};
