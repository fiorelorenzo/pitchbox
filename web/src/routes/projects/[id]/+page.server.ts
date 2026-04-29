import type { PageServerLoad } from './$types';
import { error } from '@sveltejs/kit';
import { and, desc, eq } from 'drizzle-orm';
import { getDb, schema } from '$lib/server/db.js';
import { getProjectById, listLatestConfigs } from '@pitchbox/shared/projects';

export const load: PageServerLoad = async ({ params }) => {
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) throw error(400, 'invalid id');
  const db = getDb();
  const project = await getProjectById(db, id);
  if (!project) throw error(404, 'project not found');
  const [configs, accounts, platforms, runRows] = await Promise.all([
    listLatestConfigs(db, id),
    db.select().from(schema.accounts).where(eq(schema.accounts.projectId, id)),
    db.select().from(schema.platforms),
    db
      .select()
      .from(schema.runs)
      .where(and(eq(schema.runs.projectId, id), eq(schema.runs.kind, 'project_extraction')))
      .orderBy(desc(schema.runs.startedAt))
      .limit(5),
  ]);
  const extractionRuns = runRows.map((r) => ({
    id: r.id,
    status: r.status,
    startedAt: r.startedAt.toISOString(),
    finishedAt: r.finishedAt ? r.finishedAt.toISOString() : null,
    error: r.error,
    params: (r.params ?? null) as { source?: { kind: string; value: string } } | null,
  }));
  return { project, configs, accounts, platforms, extractionRuns };
};
