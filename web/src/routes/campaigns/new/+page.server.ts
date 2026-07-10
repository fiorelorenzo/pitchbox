import type { PageServerLoad } from './$types';
import { desc, eq } from 'drizzle-orm';
import { getDb, schema } from '$lib/server/db.js';
import { AGENT_RUNNER_META } from '@pitchbox/shared/agents/meta';
import { detectAllRunners } from '@pitchbox/shared/agents/detect';
import { listProjects } from '@pitchbox/shared/projects';
import { projectBelongsToOrg } from '@pitchbox/shared/orgs';
import { resolveOrgId } from '$lib/server/auth.js';

export const load: PageServerLoad = async (event) => {
  const { url } = event;
  const db = getDb();
  const orgId = await resolveOrgId(event);
  const [projects, platforms] = await Promise.all([
    listProjects(db, { organizationId: orgId }),
    db.select().from(schema.platforms),
  ]);

  let preselected: {
    id: number;
    projectId: number;
    scenarioSlug: string;
    name: string;
    objective: string;
  } | null = null;
  const recParam = url.searchParams.get('recommendation');
  if (recParam) {
    const recId = Number(recParam);
    if (Number.isInteger(recId) && recId > 0) {
      const [rec] = await db
        .select()
        .from(schema.campaignRecommendations)
        .where(eq(schema.campaignRecommendations.id, recId));
      // Only trust a recommendation resolved from a raw query-param id if its
      // project belongs to the caller's org - otherwise silently ignore it
      // rather than leaking another org's recommendation into the picker.
      if (rec && orgId != null && (await projectBelongsToOrg(db, rec.projectId, orgId))) {
        preselected = {
          id: rec.id,
          projectId: rec.projectId,
          scenarioSlug: rec.scenarioSlug,
          name: rec.name,
          objective: rec.objective,
        };
      }
    }
  }

  const defaultProjectId = preselected?.projectId ?? projects[0]?.id ?? null;
  const recommendations = defaultProjectId
    ? await db
        .select()
        .from(schema.campaignRecommendations)
        .where(eq(schema.campaignRecommendations.projectId, defaultProjectId))
        .orderBy(desc(schema.campaignRecommendations.createdAt))
    : [];

  const detections = await detectAllRunners();
  const runners = AGENT_RUNNER_META.map((m) => ({
    slug: m.slug,
    label: m.label,
    implemented: m.implemented,
    available: m.implemented && detections[m.slug].available,
    error: m.implemented ? detections[m.slug].error : 'Runner adapter not implemented yet',
  }));

  return { projects, platforms, preselected, recommendations, runners };
};
