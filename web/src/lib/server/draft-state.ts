import { and, eq, sql } from 'drizzle-orm';
import { getDb, schema } from './db.js';

/**
 * Optimistic-locking helper for draft state transitions.
 *
 * Performs an `UPDATE drafts SET … , version = version + 1 WHERE id = $1 AND
 * version = $2` and returns `{ kind: 'ok', newVersion }` on success or
 * `{ kind: 'conflict', currentVersion }` if no row matched. Centralising the
 * pattern keeps the inbox PATCH route and the extension `/sent` route in sync
 * and makes the contract straightforward to unit-test.
 */
export type DraftPatchResult =
  { kind: 'ok'; newVersion: number } | { kind: 'conflict'; currentVersion: number };

export async function updateDraftWithVersion(
  draftId: number,
  expectedVersion: number,
  set: Partial<typeof schema.drafts.$inferInsert>,
): Promise<DraftPatchResult> {
  const db = getDb();
  const updated = await db
    .update(schema.drafts)
    .set({ ...set, version: sql`${schema.drafts.version} + 1` })
    .where(and(eq(schema.drafts.id, draftId), eq(schema.drafts.version, expectedVersion)))
    .returning({ version: schema.drafts.version });
  if (updated.length === 1) {
    return { kind: 'ok', newVersion: updated[0].version };
  }
  // No row matched the version predicate - re-read so the caller can surface
  // the current version to clients (purely advisory; they should still
  // re-fetch the full row before retrying).
  const [fresh] = await db
    .select({ version: schema.drafts.version })
    .from(schema.drafts)
    .where(eq(schema.drafts.id, draftId));
  return { kind: 'conflict', currentVersion: fresh?.version ?? expectedVersion + 1 };
}
