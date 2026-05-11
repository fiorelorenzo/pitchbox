import type { PageServerLoad } from './$types';
import { getDb } from '$lib/server/db.js';
import { listProjects } from '@pitchbox/shared/projects';

export const load: PageServerLoad = async () => {
  const projects = await listProjects(getDb());
  return { projects };
};
