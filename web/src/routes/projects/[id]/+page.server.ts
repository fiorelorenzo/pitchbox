import type { PageServerLoad } from './$types';
import { error } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '$lib/server/db.js';
import { getProjectById, listLatestConfigs } from '@pitchbox/shared/projects';

export const load: PageServerLoad = async ({ params }) => {
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) throw error(400, 'invalid id');
  const db = getDb();
  const project = await getProjectById(db, id);
  if (!project) throw error(404, 'project not found');
  const [configs, accounts, platforms] = await Promise.all([
    listLatestConfigs(db, id),
    db.select().from(schema.accounts).where(eq(schema.accounts.projectId, id)),
    db.select().from(schema.platforms),
  ]);
  return { project, configs, accounts, platforms };
};
