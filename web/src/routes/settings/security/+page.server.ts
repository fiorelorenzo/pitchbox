import type { PageServerLoad } from './$types';
import { getDb } from '../../../lib/server/db.js';
import { listRecentAuthFailures, loadAuthPolicy } from '@pitchbox/shared/auth';
import { requireRole } from '../../../lib/server/auth.js';

export const load: PageServerLoad = async (event) => {
  requireRole(event, 'admin'); // failed-login list is admin-only
  const db = getDb();
  const [policy, rows] = await Promise.all([loadAuthPolicy(db), listRecentAuthFailures(db, 50)]);
  return {
    policy,
    failures: rows.map((r) => ({
      id: r.id,
      identifier: r.identifier,
      failedAt: r.failedAt.toISOString(),
      kind: r.kind,
    })),
  };
};
