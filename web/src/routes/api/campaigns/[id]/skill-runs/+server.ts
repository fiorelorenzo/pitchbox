import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { and, desc, eq } from 'drizzle-orm';
import { getDb, schema } from '$lib/server/db.js';
import { runCampaignSkillGeneration } from '$lib/server/runner.js';

const PostBody = z.object({ objective: z.string().min(1).max(2000) });

function parseId(idParam: string): number | null {
  const n = Number(idParam);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export async function POST({ params, request }) {
  const id = parseId(params.id);
  if (!id) return json({ error: 'invalid_id' }, { status: 400 });
  const raw = await request.json().catch(() => null);
  const parsed = PostBody.safeParse(raw);
  if (!parsed.success) {
    return json({ error: 'invalid_body', issues: parsed.error.issues }, { status: 400 });
  }
  const db = getDb();
  const [campaign] = await db.select().from(schema.campaigns).where(eq(schema.campaigns.id, id));
  if (!campaign) return json({ error: 'not_found' }, { status: 404 });

  try {
    const out = await runCampaignSkillGeneration(
      id,
      campaign.skillSlug as 'reddit-scout' | 'reddit-commenter',
      parsed.data.objective,
    );
    if (out.alreadyRunning) {
      return json({ error: 'already_running', runId: out.runId }, { status: 409 });
    }
    return json({ runId: out.runId }, { status: 201 });
  } catch (e) {
    return json(
      { error: 'dispatch_failed', message: String((e as Error).message) },
      { status: 500 },
    );
  }
}

export async function GET({ params, url }) {
  const id = parseId(params.id);
  if (!id) return json({ error: 'invalid_id' }, { status: 400 });
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? '5'), 1), 50);
  const db = getDb();
  const rows = await db
    .select()
    .from(schema.runs)
    .where(and(eq(schema.runs.campaignId, id), eq(schema.runs.kind, 'campaign_skill_generation')))
    .orderBy(desc(schema.runs.startedAt))
    .limit(limit);
  return json({ runs: rows });
}
