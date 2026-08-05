import {
  loadAuditFeed,
  loadAuditEventTypes,
  parseAuditFiltersFromUrl,
  nextAuditCursor,
} from '$lib/server/audit-feed.js';
import { requireOrgId } from '$lib/server/auth.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
  const { url } = event;
  const orgId = await requireOrgId(event);
  const filters = parseAuditFiltersFromUrl(url);

  const [rows, eventTypes] = await Promise.all([
    loadAuditFeed(orgId, filters),
    loadAuditEventTypes(),
  ]);

  return {
    rows: rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })),
    eventTypes,
    filters: {
      actor: filters.actor ?? '',
      event: filters.event ?? '',
      draftId: filters.draftId ?? '',
      runId: filters.runId ?? '',
      from: url.searchParams.get('from') ?? '',
      to: url.searchParams.get('to') ?? '',
    },
    nextCursor: nextAuditCursor(rows, filters.limit!),
  };
};
