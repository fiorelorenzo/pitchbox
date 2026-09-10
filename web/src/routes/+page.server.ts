import type { RequestEvent } from '@sveltejs/kit';
import { redirect } from '@sveltejs/kit';
import { getDb, schema } from '$lib/server/db.js';
import { and, desc, eq, gte, inArray, isNotNull, or, sql } from 'drizzle-orm';
import { listProjects } from '@pitchbox/shared/projects';
import { resolveOrgId } from '$lib/server/auth.js';
import { currentEdition } from '@pitchbox/shared/edition';
import {
  getOnboardingSnapshot,
  startOnboarding,
  type OnboardingStepId,
} from '@pitchbox/shared/onboarding';

export async function load(event: RequestEvent) {
  const db = getDb();

  // LOR-182: on cloud, a tenant's dashboard must never render what their
  // runs cost the deployment - that is the Gateway bill, not something
  // they bought. Gated once here, at the loader, rather than only in the
  // markup: a number that reaches `data` is a number in the HTML payload
  // (#358's lesson). Self-host keeps every figure below exactly as it
  // always was, since the operator pays the Gateway bill there and it is
  // their own number to see.
  const showSpend = currentEdition() !== 'cloud';

  const orgId = await resolveOrgId(event);

  // #516: a fresh identity's first dashboard visit is what starts the
  // onboarding flow and, when there is genuinely something to do, redirects
  // into it - `startOnboarding` is a no-op past `not_started`, so this fires
  // at most once per (user, org). A pre-populated org (nothing left to walk
  // through) reads straight through to `completed` instead and this page
  // renders normally with no redirect at all.
  let onboarding: {
    status: string;
    currentStep: OnboardingStepId | null;
    done: number;
    total: number;
  } | null = null;
  if (orgId != null) {
    const identity = { organizationId: orgId, userId: event.locals.user?.id ?? null };
    const ctx = {
      authOn: process.env.PITCHBOX_AUTH === 'on',
      username: event.locals.user?.username ?? null,
    };
    let snapshot = await getOnboardingSnapshot(db, identity, ctx);
    if (snapshot.status === 'not_started') {
      snapshot = await startOnboarding(db, identity, ctx);
      if (snapshot.status === 'in_progress') {
        throw redirect(302, '/onboarding');
      }
    }
    if (snapshot.status === 'in_progress') {
      // The banner shows the same progress read the wizard does, so it counts
      // applicable steps only - `organization` and `verify_email` do not apply
      // with auth off or to a non-owner member.
      const applicable = snapshot.steps.filter((s) => s.applicable);
      onboarding = {
        status: snapshot.status,
        currentStep: snapshot.currentStep,
        done: applicable.filter((s) => s.complete).length,
        total: applicable.length,
      };
    }
  }

  const projects = await listProjects(db, { organizationId: orgId });
  const projectIds = projects.map((p) => p.id);

  let assistCost24h = 0;
  let assistCost7d = 0;
  if (showSpend) {
    const assistSince24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const assistSince7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    // Filtered by `organizationId` directly, not through this org's project
    // ids: #523 made `assist_usage.project_id` nullable (a suggestion can be
    // about no product at all), so an org with zero projects can still have
    // assist spend to show - the `projectIds.length === 0` early return right
    // below must not hardcode this to zero.
    const [assistSpendRow] =
      orgId == null
        ? [{ cost24h: 0, cost7d: 0 }]
        : await db
            .select({
              cost24h: sql<
                string | null
              >`COALESCE(SUM(cost_usd) FILTER (WHERE created_at >= ${assistSince24h}), 0)`,
              cost7d: sql<
                string | null
              >`COALESCE(SUM(cost_usd) FILTER (WHERE created_at >= ${assistSince7d}), 0)`,
            })
            .from(schema.assistUsage)
            .where(eq(schema.assistUsage.organizationId, orgId));
    assistCost24h = Number(assistSpendRow?.cost24h ?? 0);
    assistCost7d = Number(assistSpendRow?.cost7d ?? 0);
  }

  // No projects in this org - nothing to show, and `inArray(x, [])` is a SQL error.
  if (projectIds.length === 0) {
    return {
      onboarding,
      stats: {
        pending: 0,
        approved: 0,
        sent: 0,
        rejected: 0,
        total: 0,
        sentToday: 0,
        createdToday: 0,
        uniqueContacts: 0,
        replies: 0,
      },
      runStats7d: {
        total: 0,
        success: 0,
        failed: 0,
        running: 0,
      },
      recentRuns: [],
      campaigns: [],
      spend: showSpend ? { cost24h: 0, cost7d: 0, assistCost24h, assistCost7d } : null,
    };
  }

  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  // Runs carry their project either directly (runs.projectId - project_extraction,
  // project_insights, draft_regeneration, reply_drafting) or transitively via their
  // campaign (runs.campaignId -> campaigns.projectId - kind:'campaign',
  // campaign_skill_generation). runs.campaignId is nullable and runs.projectId is
  // NULL for every campaign run, so an `inArray(runs.projectId, ...)`-only filter
  // silently drops the dominant run kind. Match on either path, mirroring
  // runBelongsToOrg (shared/src/orgs.ts).
  const runOrgMatch = or(
    inArray(schema.runs.projectId, projectIds),
    inArray(schema.campaigns.projectId, projectIds),
  );

  // ----- Draft counts (single scan) -----
  const [draftCountsRow] = await db
    .select({
      pending: sql<number>`COUNT(*) FILTER (WHERE state = 'pending_review')::int`,
      approved: sql<number>`COUNT(*) FILTER (WHERE state = 'approved')::int`,
      sent: sql<number>`COUNT(*) FILTER (WHERE state = 'sent')::int`,
      rejected: sql<number>`COUNT(*) FILTER (WHERE state = 'rejected')::int`,
      total: sql<number>`COUNT(*)::int`,
    })
    .from(schema.drafts)
    .where(inArray(schema.drafts.projectId, projectIds));

  const [sentTodayRow] = await db
    .select({ count: sql<number>`COUNT(*)::int` })
    .from(schema.drafts)
    .where(
      and(
        eq(schema.drafts.state, 'sent'),
        gte(schema.drafts.sentAt, since24h),
        inArray(schema.drafts.projectId, projectIds),
      ),
    );

  const [createdTodayRow] = await db
    .select({ count: sql<number>`COUNT(*)::int` })
    .from(schema.drafts)
    .where(
      and(gte(schema.drafts.createdAt, since24h), inArray(schema.drafts.projectId, projectIds)),
    );

  // ----- Contacts -----
  // contact_history.organization_id is set once from the draft's project at
  // insert time and survives retention pruning the draft (draft_id -> null,
  // see docs/organization-isolation-design.md and shared/src/db/schema.ts).
  // The previous version of this query scoped by inner-joining `drafts` on
  // `draft_id` and filtering `drafts.projectId` - that silently dropped
  // every contact whose draft has since been pruned (undercounting
  // uniqueContacts/replies for any org with retention-pruned history), so
  // it was NOT redundant with a direct filter, it was actively wrong for
  // pruned rows. `organization_id` is the only column that scopes this
  // correctly; `orgId` is guarded for null the same way `resolveOrgId`'s
  // other callers in this file (via `projectIds`) already are.
  const [contactsRow] =
    orgId == null
      ? [{ unique: 0, replied: 0 }]
      : await db
          .select({
            unique: sql<number>`COUNT(DISTINCT (${schema.contactHistory.platformId}, ${schema.contactHistory.targetUser}))::int`,
            replied: sql<number>`COUNT(*) FILTER (WHERE ${schema.contactHistory.repliedAt} IS NOT NULL)::int`,
          })
          .from(schema.contactHistory)
          .where(eq(schema.contactHistory.organizationId, orgId));

  // ----- Recent runs (campaign runs only - the widget is labelled
  // 'Last 5 campaign runs' so project_extraction / skill_generation runs
  // are filtered out here). -----
  const recentRuns = await db
    .select({
      id: schema.runs.id,
      campaignId: schema.runs.campaignId,
      agentRunner: schema.runs.agentRunner,
      status: schema.runs.status,
      trigger: schema.runs.trigger,
      startedAt: schema.runs.startedAt,
      finishedAt: schema.runs.finishedAt,
      tokensUsed: schema.runs.tokensUsed,
      campaignName: schema.campaigns.name,
    })
    .from(schema.runs)
    .innerJoin(schema.campaigns, eq(schema.runs.campaignId, schema.campaigns.id))
    .where(and(eq(schema.runs.kind, 'campaign'), runOrgMatch))
    .orderBy(desc(schema.runs.startedAt))
    .limit(5);

  // ----- Spend (last 24h / 7d) - LOR-182: skipped outright on cloud, not
  // just hidden in the markup, matching the assist-spend gate above. The
  // assistant's spend lives entirely in `assist_usage`
  // (`assistCost24h`/`assistCost7d`, computed above before the
  // zero-projects early return) - #521 retired the `assist`-kind `runs`
  // row entirely, so this query is campaign/other-run cost only, with
  // nothing left to exclude. -----
  let spend: {
    cost24h: number;
    cost7d: number;
    assistCost24h: number;
    assistCost7d: number;
  } | null = null;
  if (showSpend) {
    const [spendRow] = await db
      .select({
        cost24h: sql<
          string | null
        >`COALESCE(SUM(cost_usd) FILTER (WHERE started_at >= ${since24h}), 0)`,
        cost7d: sql<
          string | null
        >`COALESCE(SUM(cost_usd) FILTER (WHERE started_at >= ${since7d}), 0)`,
      })
      .from(schema.runs)
      .leftJoin(schema.campaigns, eq(schema.campaigns.id, schema.runs.campaignId))
      .where(runOrgMatch);

    spend = {
      cost24h: Number(spendRow?.cost24h ?? 0),
      cost7d: Number(spendRow?.cost7d ?? 0),
      assistCost24h,
      assistCost7d,
    };
  }

  // ----- Run stats (last 7 days, campaign runs only - the three cards on
  // the home page are labelled 'Campaign runs', 'Successful runs',
  // 'Failed runs' and are about outreach activity, not extraction /
  // skill-generation runs). -----
  const [runStats7d] = await db
    .select({
      total: sql<number>`COUNT(*)::int`,
      success: sql<number>`COUNT(*) FILTER (WHERE ${schema.runs.status} = 'success')::int`,
      failed: sql<number>`COUNT(*) FILTER (WHERE ${schema.runs.status} IN ('failed','error','cancelled'))::int`,
      running: sql<number>`COUNT(*) FILTER (WHERE ${schema.runs.status} = 'running')::int`,
    })
    .from(schema.runs)
    .leftJoin(schema.campaigns, eq(schema.campaigns.id, schema.runs.campaignId))
    .where(and(gte(schema.runs.startedAt, since7d), eq(schema.runs.kind, 'campaign'), runOrgMatch));

  // ----- Campaigns with derived last-run info -----
  // Derive from runs table so we don't depend on campaigns.last_run_at, which is
  // only kept fresh by the scheduler (manual "Run now" leaves it stale).
  const campaignsRaw = await db
    .select({
      id: schema.campaigns.id,
      name: schema.campaigns.name,
      status: schema.campaigns.status,
      platformId: schema.campaigns.platformId,
    })
    .from(schema.campaigns)
    .where(inArray(schema.campaigns.projectId, projectIds));

  const allRuns = await db
    .select({
      id: schema.runs.id,
      campaignId: schema.runs.campaignId,
      status: schema.runs.status,
      startedAt: schema.runs.startedAt,
    })
    .from(schema.runs)
    .leftJoin(schema.campaigns, eq(schema.campaigns.id, schema.runs.campaignId))
    .where(and(isNotNull(schema.runs.campaignId), runOrgMatch))
    .orderBy(desc(schema.runs.startedAt));

  const latestRunByCampaign = new Map<number, (typeof allRuns)[number]>();
  const runningByCampaign = new Set<number>();
  for (const r of allRuns) {
    if (r.campaignId == null) continue;
    if (r.status === 'running') runningByCampaign.add(r.campaignId);
    if (!latestRunByCampaign.has(r.campaignId)) latestRunByCampaign.set(r.campaignId, r);
  }

  const campaigns = campaignsRaw
    .map((c) => {
      const lr = latestRunByCampaign.get(c.id) ?? null;
      return {
        id: c.id,
        name: c.name,
        status: c.status,
        platformId: c.platformId,
        lastRunId: lr?.id ?? null,
        lastRunStatus: lr?.status ?? null,
        lastRunStartedAt: lr?.startedAt ?? null,
        isRunning: runningByCampaign.has(c.id),
      };
    })
    .sort((a, b) => {
      const ta = a.lastRunStartedAt ? new Date(a.lastRunStartedAt).getTime() : 0;
      const tb = b.lastRunStartedAt ? new Date(b.lastRunStartedAt).getTime() : 0;
      return tb - ta;
    });

  return {
    onboarding,
    stats: {
      pending: draftCountsRow?.pending ?? 0,
      approved: draftCountsRow?.approved ?? 0,
      sent: draftCountsRow?.sent ?? 0,
      rejected: draftCountsRow?.rejected ?? 0,
      total: draftCountsRow?.total ?? 0,
      sentToday: sentTodayRow?.count ?? 0,
      createdToday: createdTodayRow?.count ?? 0,
      uniqueContacts: contactsRow?.unique ?? 0,
      replies: contactsRow?.replied ?? 0,
    },
    runStats7d: {
      total: runStats7d?.total ?? 0,
      success: runStats7d?.success ?? 0,
      failed: runStats7d?.failed ?? 0,
      running: runStats7d?.running ?? 0,
    },
    recentRuns,
    campaigns,
    spend,
  };
}
