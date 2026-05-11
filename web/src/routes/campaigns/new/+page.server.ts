import type { PageServerLoad } from './$types';
import { getDb, schema } from '$lib/server/db.js';

export const load: PageServerLoad = async () => {
  const db = getDb();
  const [projects, platforms] = await Promise.all([
    db.select().from(schema.projects),
    db.select().from(schema.platforms),
  ]);
  return { projects, platforms };
};
