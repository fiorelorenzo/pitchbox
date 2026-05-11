import type { PageServerLoad } from './$types';
import { error } from '@sveltejs/kit';
import { and, desc, eq } from 'drizzle-orm';
import { getDb, schema } from '$lib/server/db.js';
import { getProjectById } from '@pitchbox/shared/projects';

export const load: PageServerLoad = async ({ params }) => {
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) throw error(400, 'invalid id');
  const db = getDb();
  const project = await getProjectById(db, id);
  if (!project) throw error(404, 'project not found');
  const [accounts, platforms, runRows, recommendations] = await Promise.all([
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
  return { project, accounts, platforms, extractionRuns, recommendations };
};
