import { getDb, schema } from '$lib/server/db.js';
import { desc, eq, inArray, isNull, or } from 'drizzle-orm';
import { listProjects } from '@pitchbox/shared/projects';
import { resolveOrgId } from '$lib/server/auth.js';

export async function load(event: import('@sveltejs/kit').RequestEvent) {
  const db = getDb();

  const orgId = await resolveOrgId(event);
  const projects = await listProjects(db, { organizationId: orgId });
  const projectIds = projects.map((p) => p.id);

  // Project-scoped rows are limited to the org's projects; global rows
  // (project_id IS NULL) are a shared resource visible to every org - see
  // the organization-isolation design doc's accepted residual.
  const scope =
    projectIds.length > 0
      ? or(inArray(schema.blocklist.projectId, projectIds), isNull(schema.blocklist.projectId))
      : isNull(schema.blocklist.projectId);

  const entries = await db
    .select({
      id: schema.blocklist.id,
      platformId: schema.blocklist.platformId,
      platformSlug: schema.platforms.slug,
      kind: schema.blocklist.kind,
      value: schema.blocklist.value,
      reason: schema.blocklist.reason,
      scope: schema.blocklist.scope,
      projectId: schema.blocklist.projectId,
      projectSlug: schema.projects.slug,
      addedAt: schema.blocklist.addedAt,
    })
    .from(schema.blocklist)
    .leftJoin(schema.platforms, eq(schema.blocklist.platformId, schema.platforms.id))
    .leftJoin(schema.projects, eq(schema.blocklist.projectId, schema.projects.id))
    .where(scope)
    .orderBy(desc(schema.blocklist.addedAt));

  const platforms = await db.select().from(schema.platforms).orderBy(schema.platforms.slug);

  return { entries, platforms, projects };
}
