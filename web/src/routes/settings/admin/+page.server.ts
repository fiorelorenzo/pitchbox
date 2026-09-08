import type { PageServerLoad } from './$types';
import { getDb } from '$lib/server/db.js';
import { listUsers } from '@pitchbox/shared/auth';

// Lists every user with their instance-admin flag so a promotion (#413) is
// visible from the UI rather than the database. The gate for this whole
// subtree already ran in +layout.server.ts (requireInstanceAdmin), so this
// loader only needs to fetch the data.
export const load: PageServerLoad = async () => {
  const users = await listUsers(getDb());
  return { users };
};
