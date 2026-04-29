import type { PageServerLoad } from './$types';
import { getDb, schema } from '$lib/server/db.js';

export const load: PageServerLoad = async () => {
  const platforms = await getDb().select().from(schema.platforms);
  return { platforms };
};
