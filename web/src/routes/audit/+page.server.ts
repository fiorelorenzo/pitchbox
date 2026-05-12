import { loadAuditFeed, loadAuditEventTypes, type AuditFilters } from '$lib/server/audit-feed.js';

function parseIntParam(value: string | null): number | undefined {
  if (!value) return undefined;
  const n = Number(value);
  return Number.isFinite(n) && Number.isInteger(n) ? n : undefined;
}

function parseDateParam(value: string | null): Date | undefined {
  if (!value) return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

export async function load({ url }: { url: URL }) {
  const filters: AuditFilters = {
    actor: url.searchParams.get('actor') ?? undefined,
    event: url.searchParams.get('event') ?? undefined,
    draftId: parseIntParam(url.searchParams.get('draft_id')),
    runId: parseIntParam(url.searchParams.get('run_id')),
    from: parseDateParam(url.searchParams.get('from')),
    to: parseDateParam(url.searchParams.get('to')),
    limit: 100,
  };

  const cursorCreatedAt = url.searchParams.get('cursor_at');
  const cursorId = url.searchParams.get('cursor_id');
  if (cursorCreatedAt && cursorId) {
    const at = new Date(cursorCreatedAt);
    if (!Number.isNaN(at.getTime())) {
      filters.cursor = { createdAt: at, id: cursorId };
    }
  }

  const [rows, eventTypes] = await Promise.all([loadAuditFeed(filters), loadAuditEventTypes()]);

  const nextCursor =
    rows.length === filters.limit
      ? { createdAt: rows[rows.length - 1].createdAt.toISOString(), id: rows[rows.length - 1].id }
      : null;

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
    nextCursor,
  };
}
