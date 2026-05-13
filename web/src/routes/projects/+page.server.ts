import type { PageServerLoad } from './$types';
import { getDb } from '$lib/server/db.js';
import { resolveOrgId } from '$lib/server/auth.js';
import { listProjects } from '@pitchbox/shared/projects';

export const load: PageServerLoad = async (event) => {
  const orgId = await resolveOrgId(event);
  const projects = await listProjects(getDb(), { organizationId: orgId });
  return { projects };
};
