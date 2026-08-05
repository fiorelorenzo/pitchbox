import { json } from '@sveltejs/kit';
import type { RequestEvent } from '@sveltejs/kit';
import { and, eq, gte, inArray, lte, sql, type SQL } from 'drizzle-orm';
import { getDb, schema } from '@pitchbox/shared/db';
import { listProjects } from '@pitchbox/shared/projects';
import { resolveOrgId } from '$lib/server/auth.js';

export type FunnelStage = 'proposed' | 'approved' | 'sent' | 'replied';
export type FunnelRange = '7d' | '30d' | 'all';

// A stage's rate is its count as a percentage of the previous stage's count.
// `null` means there is no rate to show: either this is the first stage (no
// previous stage exists) or the previous stage's count is 0 (no denominator).
// A rate of 0 is a real measurement (a real denominator, zero conversions)
// and is distinct from `null` - callers must not collapse the two.
export type FunnelStageResult = { stage: FunnelStage; count: number; rate: number | null };

// Maps user-facing funnel stages to the corresponding `drafts.state` value.
const STAGE_STATE: Record<FunnelStage, string> = {
  proposed: 'pending_review',
  approved: 'approved',
  sent: 'sent',
  replied: 'replied',
};

const RANGE_DAYS: Record<Exclude<FunnelRange, 'all'>, number> = { '7d': 7, '30d': 30 };

// Maps a range preset to its lower bound, relative to now. `null`/`all`/an
// unrecognised value means no lower bound - the same as not filtering at all.
function rangeToFrom(value: string | null): Date | undefined {
  const days = value ? RANGE_DAYS[value as Exclude<FunnelRange, 'all'>] : undefined;
  return days ? new Date(Date.now() - days * 24 * 60 * 60 * 1000) : undefined;
}

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

// Attaches the conversion rate against the previous stage. Pure so it is
// exercised the same way whether the funnel came from a real query or the
// zeroed-out no-projects shortcut below.
function withRates(counts: { stage: FunnelStage; count: number }[]): FunnelStageResult[] {
  return counts.map((c, i) => {
    const prev = i > 0 ? counts[i - 1].count : undefined;
    const rate = prev === undefined || prev === 0 ? null : Math.round((c.count / prev) * 100);
    return { ...c, rate };
  });
}

export async function GET(event: RequestEvent) {
  const { url } = event;
  const campaignId = parseInt(url.searchParams.get('campaign_id'));
  // `range` is the preset control on the page; raw `from`/`to` remain as a
  // generic escape hatch and only apply when no range preset is given.
  const from =
    rangeToFrom(url.searchParams.get('range')) ?? parseDate(url.searchParams.get('from'));
  const to = parseDate(url.searchParams.get('to'));

  const db = getDb();
  const orgId = await resolveOrgId(event);
  const projects = await listProjects(db, { organizationId: orgId });
  const projectIds = projects.map((p) => p.id);

  const stages: FunnelStage[] = ['proposed', 'approved', 'sent', 'replied'];

  // No projects in this org - a zeroed-out funnel. `inArray(x, [])` is a SQL error.
  if (projectIds.length === 0) {
    return json({ stages: withRates(stages.map((stage) => ({ stage, count: 0 }))) });
  }

  const results = await Promise.all(
    stages.map(async (stage) => {
      const filters: SQL[] = [
        eq(schema.drafts.state, STAGE_STATE[stage]),
        inArray(schema.drafts.projectId, projectIds),
      ];
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

  return json({ stages: withRates(results) });
}
