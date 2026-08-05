import { and, eq, desc, gte, inArray, sql, type SQL } from 'drizzle-orm';
import { schema, type Db } from './db.js';
import { getUsageForAccounts, loadQuotaLimits } from '@pitchbox/shared/quota';
import { listProjects } from '@pitchbox/shared/projects';
import type { UsageByKind, QuotaLimits } from '@pitchbox/shared/quota-types';

export const INBOX_PAGE_SIZE = 50;

// Every value here must round-trip through the state tabs / kind menu on the
// page (STATES / KINDS in +page.svelte) or be a bare numeric id (run,
// campaign). An unrecognised value is never applied as-is - that would
// either fail as a SQL param or, worse, silently render an unfiltered inbox
// as if the requested filter had matched nothing. Instead it falls back to
// the default and the raw value is reported back on `*FilterInvalid` so the
// page can tell the user their filter was ignored (#239).
const VALID_STATES: Record<string, true> = {
  pending_review: true,
  approved: true,
  sent: true,
  rejected: true,
  all: true,
};
const VALID_KINDS: Record<string, true> = {
  dm: true,
  post: true,
  post_comment: true,
  comment_reply: true,
};

export type InboxCursor = { createdAt: Date; id: string } | null;

// Cursor pagination (see /audit): order by (created_at, id) desc, both
// descending, so the cursor tuple is monotonic and stable under concurrent
// inserts - a timestamp alone could tie and skip/duplicate rows.
export function parseInboxCursor(url: URL): InboxCursor {
  const cursorAtRaw = url.searchParams.get('cursor_at');
  const cursorIdRaw = url.searchParams.get('cursor_id');
  return cursorAtRaw && cursorIdRaw && !Number.isNaN(new Date(cursorAtRaw).getTime())
    ? { createdAt: new Date(cursorAtRaw), id: cursorIdRaw }
    : null;
}

export type InboxProject = { id: number; slug: string; name: string };
export type InboxPlatform = { id: number; slug: string };

export type InboxFilterFlags = {
  stateFilterInvalid: string | null;
  kindFilterInvalid: string | null;
  runFilterInvalid: string | null;
  campaignFilterInvalid: string | null;
};

export type InboxEmptyScope = {
  empty: 'no-projects' | 'invalid-platform' | 'campaign-not-found';
  state: string;
  kind: string | null;
  run: null;
  campaign: string | null;
  projectsForUi: InboxProject[];
  activeProject: InboxProject | null;
  allPlatforms: InboxPlatform[];
  activePlatform: InboxPlatform | null;
  filterInvalid: InboxFilterFlags;
};

export type InboxResolvedScope = {
  empty: null;
  state: string;
  kind: string | null;
  run: string | null;
  campaign: string | null;
  projectIds: number[];
  projectsForUi: InboxProject[];
  activeProject: InboxProject | null;
  allPlatforms: InboxPlatform[];
  activePlatform: InboxPlatform | null;
  minQuality: number | null;
  runId: number | null;
  campaignRunIds: number[] | null;
  filterInvalid: InboxFilterFlags;
};

export type InboxScope = InboxEmptyScope | InboxResolvedScope;

/**
 * Resolves org/project/platform/state/kind/campaign scope from the request
 * URL. Shared by the page loader (which also needs the resolved lists for
 * the filter dropdowns) and the "Load more" JSON endpoint (which only needs
 * it to filter identically to the page it is paginating) - see /audit for
 * the pattern this mirrors. Keeping this in one place is what lets the two
 * stay in lockstep.
 */
export async function resolveInboxScope(
  db: Db,
  orgId: number | null,
  url: URL,
): Promise<InboxScope> {
  const draftParam = url.searchParams.get('draft');
  // A `?draft=<id>` deep link (from Contacts, Search, Audit, …) must be able
  // to find the draft regardless of its current state, so the default state
  // filter widens to `all` unless the caller pins an explicit `state`.
  const defaultState = draftParam ? 'all' : 'pending_review';

  const rawState = url.searchParams.get('state');
  const stateFilterInvalid = rawState != null && !VALID_STATES[rawState] ? rawState : null;
  const state = stateFilterInvalid ? defaultState : (rawState ?? defaultState);

  const rawKind = url.searchParams.get('kind');
  const kindFilterInvalid = rawKind != null && !VALID_KINDS[rawKind] ? rawKind : null;
  const kind = kindFilterInvalid ? null : rawKind;

  const rawRun = url.searchParams.get('run');
  const runFilterInvalid = rawRun != null && !/^\d+$/.test(rawRun) ? rawRun : null;
  const run = runFilterInvalid ? null : rawRun;

  const rawCampaign = url.searchParams.get('campaign');
  const campaignFilterInvalid =
    rawCampaign != null && !/^\d+$/.test(rawCampaign) ? rawCampaign : null;
  const campaign = campaignFilterInvalid ? null : rawCampaign;

  const filterInvalid: InboxFilterFlags = {
    stateFilterInvalid,
    kindFilterInvalid,
    runFilterInvalid,
    campaignFilterInvalid,
  };

  const projectSlug = url.searchParams.get('project') ?? '';
  const platformSlugFilter = url.searchParams.get('platform');
  const minQualityRaw = url.searchParams.get('minQuality');
  const minQuality =
    minQualityRaw != null && minQualityRaw !== '' && Number.isFinite(Number(minQualityRaw))
      ? Math.max(0, Math.min(100, Number(minQualityRaw)))
      : null;

  const projects = orgId != null ? await listProjects(db, { organizationId: orgId }) : [];
  const activeProject = projectSlug ? (projects.find((p) => p.slug === projectSlug) ?? null) : null;
  const projectsForUi = projects.map((p) => ({ id: p.id, slug: p.slug, name: p.name }));
  const projectIds = projects.map((p) => p.id);

  const allPlatforms = await db
    .select({ id: schema.platforms.id, slug: schema.platforms.slug })
    .from(schema.platforms);
  const activePlatform = platformSlugFilter
    ? (allPlatforms.find((p) => p.slug === platformSlugFilter) ?? null)
    : null;

  // No projects in this org - render an empty inbox. `inArray(x, [])` is a SQL error.
  if (projectIds.length === 0) {
    return {
      empty: 'no-projects',
      state,
      kind,
      run: null,
      campaign,
      projectsForUi,
      activeProject,
      allPlatforms,
      activePlatform,
      filterInvalid,
    };
  }

  if (platformSlugFilter && !activePlatform) {
    return {
      empty: 'invalid-platform',
      state,
      kind,
      run: null,
      campaign,
      projectsForUi,
      activeProject,
      allPlatforms,
      activePlatform: null,
      filterInvalid,
    };
  }

  let campaignRunIds: number[] | null = null;
  if (!run && campaign) {
    const runs = await db
      .select({ id: schema.runs.id })
      .from(schema.runs)
      .where(eq(schema.runs.campaignId, Number(campaign)));
    if (runs.length === 0) {
      return {
        empty: 'campaign-not-found',
        state,
        kind,
        run: null,
        campaign,
        projectsForUi,
        activeProject,
        allPlatforms,
        activePlatform,
        filterInvalid,
      };
    }
    campaignRunIds = runs.map((r) => r.id);
  }

  return {
    empty: null,
    state,
    kind,
    run,
    campaign,
    projectIds,
    projectsForUi,
    activeProject,
    allPlatforms,
    activePlatform,
    minQuality,
    runId: run ? Number(run) : null,
    campaignRunIds,
    filterInvalid,
  };
}

export type InboxDraft = {
  id: number;
  runId: number;
  projectId: number;
  platformId: number;
  accountId: number;
  kind: string;
  state: string;
  fitScore: number | null;
  targetUser: string | null;
  sourceRef: Record<string, unknown>;
  title: string | null;
  body: string;
  composeUrl: string | null;
  reasoning: string | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
  reviewedAt: Date | null;
  sentAt: Date | null;
  sentContent: string | null;
  platformCommentId: string | null;
  dedupWarning: string | null;
  scheduledSendAfter: Date | null;
  qualityScore: number | null;
  qualityReason: string | null;
  variantGroupId: string | null;
  variantLabel: string | null;
  regenerationCount: number;
  regeneratingRunId: number | null;
  draftingRunId: number | null;
  draftingRunStatus: string | null;
  version: number;
  platformSlug: string | null;
  project: { id: number; slug: string; name: string };
};

export type InboxDraftsPage = {
  drafts: InboxDraft[];
  totalCount: number;
  nextCursor: { createdAt: string; id: string } | null;
  usage: Record<number, UsageByKind>;
  quotaLimitsByPlatform: Record<number, QuotaLimits>;
};

/**
 * Runs the actual paginated drafts query for a resolved, non-empty
 * `InboxScope`. Used by both the page loader (first page) and the "Load
 * more" JSON endpoint (subsequent pages) so the SQL never drifts between
 * them.
 */
export async function queryInboxDraftsPage(
  db: Db,
  scope: InboxResolvedScope,
  cursor: InboxCursor,
  pageSize = INBOX_PAGE_SIZE,
): Promise<InboxDraftsPage> {
  // Mandatory org scope - applies even with no project selected.
  const filters: SQL[] = [inArray(schema.drafts.projectId, scope.projectIds)];
  if (scope.state !== 'all') filters.push(eq(schema.drafts.state, scope.state));
  if (scope.kind) filters.push(eq(schema.drafts.kind, scope.kind));
  if (scope.activeProject) filters.push(eq(schema.drafts.projectId, scope.activeProject.id));
  if (scope.activePlatform) filters.push(eq(schema.drafts.platformId, scope.activePlatform.id));
  if (scope.minQuality != null) filters.push(gte(schema.drafts.qualityScore, scope.minQuality));

  if (scope.runId != null) {
    filters.push(eq(schema.drafts.runId, scope.runId));
  } else if (scope.campaignRunIds != null) {
    filters.push(inArray(schema.drafts.runId, scope.campaignRunIds));
  }

  // Cheap total: every filter above is a direct, indexed column on `drafts`
  // itself (no joins needed), so counting against the same filter set costs
  // one indexed scan - safe to run on this hot path.
  const [totalRow] = await db
    .select({ count: sql<number>`COUNT(*)::int` })
    .from(schema.drafts)
    .where(filters.length > 0 ? and(...filters) : undefined);
  const totalCount = totalRow?.count ?? 0;

  const pageFilters = cursor
    ? [
        ...filters,
        sql`(${schema.drafts.createdAt}, ${schema.drafts.id}) < (${cursor.createdAt.toISOString()}::timestamptz, ${cursor.id}::bigint)`,
      ]
    : filters;

  // JOIN projects. Enumerate every draft column explicitly so the page does not lose data.
  const draftRows = await db
    .select({
      id: schema.drafts.id,
      runId: schema.drafts.runId,
      projectId: schema.drafts.projectId,
      platformId: schema.drafts.platformId,
      accountId: schema.drafts.accountId,
      kind: schema.drafts.kind,
      state: schema.drafts.state,
      fitScore: schema.drafts.fitScore,
      targetUser: schema.drafts.targetUser,
      sourceRef: schema.drafts.sourceRef,
      title: schema.drafts.title,
      body: schema.drafts.body,
      composeUrl: schema.drafts.composeUrl,
      reasoning: schema.drafts.reasoning,
      metadata: schema.drafts.metadata,
      createdAt: schema.drafts.createdAt,
      reviewedAt: schema.drafts.reviewedAt,
      sentAt: schema.drafts.sentAt,
      sentContent: schema.drafts.sentContent,
      platformCommentId: schema.drafts.platformCommentId,
      dedupWarning: schema.drafts.dedupWarning,
      scheduledSendAfter: schema.drafts.scheduledSendAfter,
      qualityScore: schema.drafts.qualityScore,
      qualityReason: schema.drafts.qualityReason,
      variantGroupId: schema.drafts.variantGroupId,
      variantLabel: schema.drafts.variantLabel,
      regenerationCount: schema.drafts.regenerationCount,
      regeneratingRunId: schema.drafts.regeneratingRunId,
      draftingRunId: schema.drafts.draftingRunId,
      draftingRunStatus: schema.runs.status,
      version: schema.drafts.version,
      projectSlug: schema.projects.slug,
      projectName: schema.projects.name,
      platformSlug: schema.platforms.slug,
    })
    .from(schema.drafts)
    .innerJoin(schema.projects, eq(schema.projects.id, schema.drafts.projectId))
    .innerJoin(schema.platforms, eq(schema.platforms.id, schema.drafts.platformId))
    .leftJoin(schema.runs, eq(schema.runs.id, schema.drafts.draftingRunId))
    .where(pageFilters.length > 0 ? and(...pageFilters) : undefined)
    .orderBy(desc(schema.drafts.createdAt), desc(schema.drafts.id))
    .limit(pageSize);

  const drafts: InboxDraft[] = draftRows.map(
    ({ projectSlug, projectName, platformSlug, ...rest }) => ({
      ...rest,
      // drafts.source_ref / drafts.metadata are jsonb columns with no
      // drizzle $type<>() on them (only 1 of 13 jsonb columns in the shared
      // schema uses that today), so drizzle infers `unknown` here. Both
      // columns are NOT NULL with a `{}` default and every writer (cli
      // commands, playbooks) always stores a plain object, so casting to
      // the object shape reflects what the column actually holds.
      sourceRef: rest.sourceRef as Record<string, unknown>,
      metadata: rest.metadata as Record<string, unknown>,
      platformSlug,
      project: { id: rest.projectId, slug: projectSlug, name: projectName },
    }),
  );

  const nextCursor =
    drafts.length === pageSize
      ? {
          createdAt: new Date(drafts[drafts.length - 1].createdAt).toISOString(),
          id: String(drafts[drafts.length - 1].id),
        }
      : null;

  const accountIds = Array.from(new Set(drafts.map((d) => d.accountId)));
  const platformIds = Array.from(new Set(drafts.map((d) => d.platformId)));
  const usage = accountIds.length > 0 ? await getUsageForAccounts(db, accountIds) : {};

  const quotaLimitsByPlatform: Record<number, QuotaLimits> = {};
  if (platformIds.length > 0) {
    const rows = await db
      .select({ id: schema.platforms.id, slug: schema.platforms.slug })
      .from(schema.platforms)
      .where(inArray(schema.platforms.id, platformIds));
    for (const row of rows) {
      quotaLimitsByPlatform[row.id] = await loadQuotaLimits(db, row.slug);
    }
  }

  return { drafts, totalCount, nextCursor, usage, quotaLimitsByPlatform };
}
