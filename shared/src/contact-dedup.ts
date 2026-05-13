// Helper used by drafts:create (and any other code path producing outreach) to
// detect repeat contact within a configurable window. Returns the most recent
// prior contact timestamp and whether it falls inside the policy window.
import { and, desc, eq, gte } from 'drizzle-orm';
import type { Db } from './db/client.js';
import { contactHistory } from './db/schema.js';

export interface CheckContactDedupInput {
  platformId: number;
  targetUser: string;
  windowDays: number;
}

export interface ContactDedupResult {
  priorContactedAt: Date | null;
  withinWindow: boolean;
}

export async function checkContactDedup(
  db: Db,
  input: CheckContactDedupInput,
): Promise<ContactDedupResult> {
  const { platformId, targetUser, windowDays } = input;
  const cutoff = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
  const rows = await db
    .select({ lastContactedAt: contactHistory.lastContactedAt })
    .from(contactHistory)
    .where(
      and(
        eq(contactHistory.platformId, platformId),
        eq(contactHistory.targetUser, targetUser),
        gte(contactHistory.lastContactedAt, cutoff),
      ),
    )
    .orderBy(desc(contactHistory.lastContactedAt))
    .limit(1);
  if (rows.length === 0) {
    // No prior contact at all in window. We still look up the most recent prior
    // contact (without window filter) so callers can decide whether to surface
    // older history as informational.
    const any = await db
      .select({ lastContactedAt: contactHistory.lastContactedAt })
      .from(contactHistory)
      .where(
        and(eq(contactHistory.platformId, platformId), eq(contactHistory.targetUser, targetUser)),
      )
      .orderBy(desc(contactHistory.lastContactedAt))
      .limit(1);
    return {
      priorContactedAt: any[0]?.lastContactedAt ?? null,
      withinWindow: false,
    };
  }
  return {
    priorContactedAt: rows[0].lastContactedAt,
    withinWindow: true,
  };
}

export interface DedupPolicy {
  windowDays: number;
  mode: 'warn' | 'skip';
}

export const DEFAULT_DEDUP_POLICY: DedupPolicy = {
  windowDays: 90,
  mode: 'warn',
};

export function parseDedupPolicy(raw: unknown): DedupPolicy {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_DEDUP_POLICY };
  const obj = raw as Record<string, unknown>;
  const windowDays =
    typeof obj.window_days === 'number' && obj.window_days > 0
      ? Math.floor(obj.window_days)
      : DEFAULT_DEDUP_POLICY.windowDays;
  const mode = obj.mode === 'skip' ? 'skip' : 'warn';
  return { windowDays, mode };
}
