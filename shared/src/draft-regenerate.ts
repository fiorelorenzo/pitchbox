// Stub regeneration helper for issue #22. A future iteration will invoke the
// runner in `regenerate-single` mode to actually rewrite the draft body using
// the supplied hint; today we increment the counter, persist the hint, and
// append a `regenerated` draft_event so the inbox can display the audit trail.
import { eq, sql } from 'drizzle-orm';
import type { Db } from './db/client.js';
import { drafts, draftEvents, draftRegenerationHints } from './db/schema.js';

export interface RegenerateDraftInput {
  draftId: number;
  hint?: string | null;
  authorUserId?: number | null;
  actor?: string;
}

export interface RegenerateDraftResult {
  draftId: number;
  regenerationCount: number;
  hintId: number | null;
}

export async function regenerateDraft(
  db: Db,
  input: RegenerateDraftInput,
): Promise<RegenerateDraftResult> {
  const { draftId } = input;
  const [updated] = await db
    .update(drafts)
    .set({
      regenerationCount: sql`${drafts.regenerationCount} + 1`,
      version: sql`${drafts.version} + 1`,
    })
    .where(eq(drafts.id, draftId))
    .returning({ regenerationCount: drafts.regenerationCount });

  let hintId: number | null = null;
  if (input.hint && input.hint.trim().length > 0) {
    const [row] = await db
      .insert(draftRegenerationHints)
      .values({
        draftId,
        hintText: input.hint,
        authorUserId: input.authorUserId ?? null,
      })
      .returning({ id: draftRegenerationHints.id });
    hintId = row.id;
  }

  await db.insert(draftEvents).values({
    draftId,
    event: 'regenerated',
    actor: input.actor ?? 'user',
    details: {
      hint: input.hint ?? null,
      hintId,
      regenerationCount: updated?.regenerationCount ?? null,
    },
  });

  return {
    draftId,
    regenerationCount: updated?.regenerationCount ?? 0,
    hintId,
  };
}
