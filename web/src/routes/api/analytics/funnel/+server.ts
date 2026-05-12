import { json } from '@sveltejs/kit';
import { and, eq, gte, lte, sql, type SQL } from 'drizzle-orm';
import { getDb, schema } from '@pitchbox/shared/db';

export type FunnelStage = 'proposed' | 'approved' | 'sent' | 'replied';

// Maps user-facing funnel stages to the corresponding `drafts.state` value.
const STAGE_STATE: Record<FunnelStage, string> = {
  proposed: 'pending_review',
  approved: 'approved',
  sent: 'sent',
  replied: 'replied',
};

function parseInt(value: string | null): number | undefined {
  if (!value) return undefined;
  const n = Number(value);
  return Number.isFinite(n) && Number.isInteger(n) && n > 0 ? n : undefined;
}

function parseDate(value: string | null): Date | undefined {
  if (!value) return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

export async function GET({ url }: { url: URL }) {
  const campaignId = parseInt(url.searchParams.get('campaign_id'));
  const from = parseDate(url.searchParams.get('from'));
  const to = parseDate(url.searchParams.get('to'));

  const db = getDb();

  const stages: FunnelStage[] = ['proposed', 'approved', 'sent', 'replied'];
  const results = await Promise.all(
    stages.map(async (stage) => {
      const filters: SQL[] = [eq(schema.drafts.state, STAGE_STATE[stage])];
      if (from) filters.push(gte(schema.drafts.createdAt, from));
      if (to) filters.push(lte(schema.drafts.createdAt, to));

      let query = db
        .select({ count: sql<number>`count(*)::int` })
        .from(schema.drafts)
        .$dynamic();

      if (campaignId !== undefined) {
        query = query.innerJoin(schema.runs, eq(schema.drafts.runId, schema.runs.id));
        filters.push(eq(schema.runs.campaignId, campaignId));
      }

      const [row] = await query.where(and(...filters));
      return { stage, count: row?.count ?? 0 };
    }),
  );

  return json({ stages: results });
}
