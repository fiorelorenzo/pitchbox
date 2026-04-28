import { getDb, schema } from '$lib/server/db.js';
import { and, eq, desc, inArray, type SQL } from 'drizzle-orm';
import { getUsageForAccounts, loadQuotaLimits } from '@pitchbox/shared/quota';

export async function load({ url }: { url: URL }) {
  const state = url.searchParams.get('state') ?? 'pending_review';
  const kind = url.searchParams.get('kind');
  const run = url.searchParams.get('run');
  const campaign = url.searchParams.get('campaign');
  const db = getDb();
  const filters: SQL[] = state !== 'all' ? [eq(schema.drafts.state, state)] : [];
  if (kind) filters.push(eq(schema.drafts.kind, kind));
  if (run) {
    filters.push(eq(schema.drafts.runId, Number(run)));
  } else if (campaign) {
    const runs = await db
      .select({ id: schema.runs.id })
      .from(schema.runs)
      .where(eq(schema.runs.campaignId, Number(campaign)));
    if (runs.length === 0) {
      return {
        drafts: [],
        state,
        kind,
        run: null,
        campaign,
        runInfo: null,
        campaignInfo: null,
        usage: {},
        quotaLimitsByPlatform: {},
        accountsById: {},
      };
    }
    filters.push(
      inArray(
        schema.drafts.runId,
        runs.map((r) => r.id),
      ),
    );
  }
  const drafts = await db
    .select()
    .from(schema.drafts)
    .where(filters.length > 0 ? and(...filters) : undefined)
    .orderBy(desc(schema.drafts.createdAt))
    .limit(200);

  const accountIds = Array.from(new Set(drafts.map((d) => d.accountId)));
  const platformIds = Array.from(new Set(drafts.map((d) => d.platformId)));
  const usage = accountIds.length > 0 ? await getUsageForAccounts(db, accountIds) : {};

  const accountsById: Record<number, { id: number; handle: string; platformId: number }> = {};
  if (accountIds.length > 0) {
    const accountRows = await db
      .select({ id: schema.accounts.id, handle: schema.accounts.handle, platformId: schema.accounts.platformId })
      .from(schema.accounts)
      .where(inArray(schema.accounts.id, accountIds));
    for (const row of accountRows) {
      accountsById[row.id] = row;
    }
  }

  const quotaLimitsByPlatform: Record<number, Awaited<ReturnType<typeof loadQuotaLimits>>> = {};
  if (platformIds.length > 0) {
    const rows = await db
      .select({ id: schema.platforms.id, slug: schema.platforms.slug })
      .from(schema.platforms)
      .where(inArray(schema.platforms.id, platformIds));
    for (const row of rows) {
      quotaLimitsByPlatform[row.id] = await loadQuotaLimits(db, row.slug);
    }
  }

  let runInfo: {
    id: number;
    campaignId: number;
    status: string;
    startedAt: Date;
    campaignName: string | null;
  } | null = null;
  let campaignInfo: { id: number; name: string } | null = null;

  if (run) {
    const [r] = await db
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.id, Number(run)));
    if (r) {
      const [c] = await db
        .select()
        .from(schema.campaigns)
        .where(eq(schema.campaigns.id, r.campaignId));
      runInfo = { ...r, campaignName: c?.name ?? null };
    }
  }
  if (campaign) {
    const [c] = await db
      .select()
      .from(schema.campaigns)
      .where(eq(schema.campaigns.id, Number(campaign)));
    if (c) campaignInfo = c;
  }

  return { drafts, state, kind, run, campaign, runInfo, campaignInfo, usage, quotaLimitsByPlatform, accountsById };
}
