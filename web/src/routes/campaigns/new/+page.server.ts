import type { PageServerLoad } from './$types';
import { desc, eq } from 'drizzle-orm';
import { getDb, schema } from '$lib/server/db.js';

export const load: PageServerLoad = async ({ url }) => {
  const db = getDb();
  const [projects, platforms] = await Promise.all([
    db.select().from(schema.projects),
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
      if (rec) {
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

  return { projects, platforms, preselected, recommendations };
};
