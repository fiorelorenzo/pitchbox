import type { PageServerLoad } from './$types';
import { getDb } from '../../../lib/server/db.js';
import { listRecentAuthFailures, loadAuthPolicy } from '@pitchbox/shared/auth';

export const load: PageServerLoad = async () => {
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
