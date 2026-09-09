import type { PageServerLoad } from './$types';
import { getDb } from '$lib/server/db.js';
import { listUsers } from '@pitchbox/shared/auth';
import { loadRegistrationPolicy } from '@pitchbox/shared/registration-policy';

// Lists every user with their instance-admin flag so a promotion (#413) is
// visible from the UI rather than the database, and the current
// registration policy (#505) so the switch on this page reflects the
// stored value rather than a client-side guess. The gate for this whole
// subtree already ran in +layout.server.ts (requireInstanceAdmin), so this
// loader only needs to fetch the data.
export const load: PageServerLoad = async () => {
  const db = getDb();
  const [users, registrationPolicy] = await Promise.all([
    listUsers(db),
    loadRegistrationPolicy(db),
  ]);
  return { users, registrationPolicy };
};
