import { getDb } from '$lib/server/db.js';
import { countUsers } from '@pitchbox/shared/auth';

export async function load() {
  const authOn = process.env.PITCHBOX_AUTH === 'on';
  const userCount = authOn ? await countUsers(getDb()) : 0;
  return {
    authOn,
    firstUser: authOn && userCount === 0,
  };
}
