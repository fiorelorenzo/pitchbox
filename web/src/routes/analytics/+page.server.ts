import { getDb, schema } from '@pitchbox/shared/db';
import { asc, inArray } from 'drizzle-orm';
import { listProjects } from '@pitchbox/shared/projects';
import { resolveOrgId } from '$lib/server/auth.js';

export async function load(event: import('@sveltejs/kit').RequestEvent) {
  const db = getDb();
  const orgId = await resolveOrgId(event);
  const projects = await listProjects(db, { organizationId: orgId });
  const projectIds = projects.map((p) => p.id);

  // No projects in this org - nothing to show, and `inArray(x, [])` is a SQL error.
  if (projectIds.length === 0) {
    return { campaigns: [] };
  }

  const campaigns = await db
    .select({ id: schema.campaigns.id, name: schema.campaigns.name })
    .from(schema.campaigns)
    .where(inArray(schema.campaigns.projectId, projectIds))
    .orderBy(asc(schema.campaigns.name));
  return { campaigns };
}
