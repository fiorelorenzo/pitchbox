import type { RequestEvent } from '@sveltejs/kit';
import { getDb, schema } from '$lib/server/db.js';
import { and, eq, inArray } from 'drizzle-orm';
import { loadQualityRubric } from '@pitchbox/shared/quality-judge';
import { runBelongsToOrg } from '@pitchbox/shared/orgs';
import { resolveOrgId } from '$lib/server/auth.js';
import { getExtensionDeviceNudge, hasChatUnauthorizedDevice } from '$lib/server/extension-sync.js';
import {
  resolveInboxScope,
  queryInboxDraftsPage,
  parseInboxCursor,
} from '$lib/server/inbox-query.js';

export async function load(event: RequestEvent) {
  const { url } = event;
  const db = getDb();
  const qualityRubric = await loadQualityRubric(db);

  const orgId = await resolveOrgId(event);
  const chatSyncUnauthorized = await hasChatUnauthorizedDevice();
  const extensionNudge = orgId != null ? await getExtensionDeviceNudge(orgId) : null;

  const scope = await resolveInboxScope(db, orgId, url);

  const base = {
    state: scope.state,
    kind: scope.kind,
    campaign: scope.campaign,
    projects: scope.projectsForUi,
    activeProject: scope.activeProject,
    platforms: scope.allPlatforms,
    activePlatform: scope.activePlatform,
    chatSyncUnauthorized,
    extensionNudge,
    orgId,
    qualityRubric,
    ...scope.filterInvalid,
  };

  if (scope.empty) {
    return {
      ...base,
      drafts: [],
      run: null,
      runInfo: null,
      campaignInfo: null,
      usage: {},
      quotaLimitsByPlatform: {},
      nextCursor: null,
      totalCount: 0,
    };
  }

  const cursor = parseInboxCursor(url);
  const { drafts, totalCount, nextCursor, usage, quotaLimitsByPlatform } =
    await queryInboxDraftsPage(db, scope, cursor);

  let runInfo: {
    id: number;
    campaignId: number;
    status: string;
    startedAt: Date;
    campaignName: string | null;
  } | null = null;
  let campaignInfo: { id: number; name: string } | null = null;

  if (scope.run && orgId != null) {
    // A run-scoped `inArray(runs.projectId, projectIds)` filter misses every
    // kind:'campaign' run (runs.projectId is NULL for those - the project
    // lives on runs.campaignId -> campaigns.projectId instead), so gate this
    // by-id lookup with the helper that already matches both paths instead.
    const runId = Number(scope.run);
    if (await runBelongsToOrg(db, runId, orgId)) {
      const [r] = await db.select().from(schema.runs).where(eq(schema.runs.id, runId));
      if (r && r.campaignId != null) {
        const [c] = await db
          .select()
          .from(schema.campaigns)
          .where(eq(schema.campaigns.id, r.campaignId));
        runInfo = {
          id: r.id,
          campaignId: r.campaignId,
          status: r.status,
          startedAt: r.startedAt,
          campaignName: c?.name ?? null,
        };
      }
    }
  }
  if (scope.campaign) {
    const [c] = await db
      .select()
      .from(schema.campaigns)
      .where(
        and(
          eq(schema.campaigns.id, Number(scope.campaign)),
          inArray(schema.campaigns.projectId, scope.projectIds),
        ),
      );
    if (c) campaignInfo = c;
  }

  return {
    ...base,
    drafts,
    run: scope.run,
    runInfo,
    campaignInfo,
    usage,
    quotaLimitsByPlatform,
    nextCursor,
    totalCount,
  };
}
