import type { PageServerLoad } from './$types';
import { error } from '@sveltejs/kit';
import { and, desc, eq } from 'drizzle-orm';
import { getDb, schema } from '$lib/server/db.js';
import { getProjectById } from '@pitchbox/shared/projects';
import { requireOrgId } from '$lib/server/auth.js';
import { projectBelongsToOrg } from '@pitchbox/shared/orgs';

export const load: PageServerLoad = async (event) => {
  const { params } = event;
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) throw error(400, 'invalid id');
  const orgId = await requireOrgId(event);
  if (!(await projectBelongsToOrg(getDb(), id, orgId))) throw error(404, 'not_found');
  const db = getDb();
  const project = await getProjectById(db, id);
  if (!project) throw error(404, 'project not found');
  const [accounts, platforms, runRows, recommendations, templates, latestInsight] =
    await Promise.all([
      db.select().from(schema.accounts).where(eq(schema.accounts.projectId, id)),
      db.select().from(schema.platforms),
      db
        .select()
        .from(schema.runs)
        .where(and(eq(schema.runs.projectId, id), eq(schema.runs.kind, 'project_extraction')))
        .orderBy(desc(schema.runs.startedAt))
        .limit(30),
      db
        .select()
        .from(schema.campaignRecommendations)
        .where(eq(schema.campaignRecommendations.projectId, id))
        .orderBy(desc(schema.campaignRecommendations.createdAt)),
      db
        .select()
        .from(schema.templates)
        .where(eq(schema.templates.projectId, id))
        .orderBy(desc(schema.templates.createdAt)),
      db
        .select()
        .from(schema.projectInsights)
        .where(eq(schema.projectInsights.projectId, id))
        .orderBy(desc(schema.projectInsights.generatedAt))
        .limit(1)
        .then((rows) => rows[0] ?? null),
    ]);
  const extractionRuns = runRows.map((r) => {
    const startedAtMs =
      r.startedAt instanceof Date
        ? r.startedAt.getTime()
        : new Date(r.startedAt as unknown as string).getTime();
    const finishedAtMs =
      r.finishedAt == null
        ? null
        : r.finishedAt instanceof Date
          ? r.finishedAt.getTime()
          : new Date(r.finishedAt as unknown as string).getTime();
    return {
      id: r.id,
      status: r.status,
      trigger: r.trigger,
      agentRunner: r.agentRunner,
      startedAt:
        r.startedAt instanceof Date
          ? r.startedAt.toISOString()
          : (r.startedAt as unknown as string),
      finishedAt:
        r.finishedAt == null
          ? null
          : r.finishedAt instanceof Date
            ? r.finishedAt.toISOString()
            : (r.finishedAt as unknown as string),
      durationMs: finishedAtMs != null ? finishedAtMs - startedAtMs : null,
      tokensUsed: r.tokensUsed ?? null,
      error: r.error,
      params: (r.params ?? null) as { source?: { kind: string; value: string } } | null,
    };
  });
  const latestInsightSerialized = latestInsight
    ? {
        id: latestInsight.id,
        summaryMd: latestInsight.summaryMd,
        evidence: latestInsight.evidence,
        generatedAt:
          latestInsight.generatedAt instanceof Date
            ? latestInsight.generatedAt.toISOString()
            : (latestInsight.generatedAt as unknown as string),
      }
    : null;
  return {
    project,
    accounts,
    platforms,
    extractionRuns,
    recommendations,
    templates,
    latestInsight: latestInsightSerialized,
  };
};
