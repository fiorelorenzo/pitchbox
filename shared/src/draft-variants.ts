// A/B variant grouping for drafts (issue #20).
//
// Drafts that share a `variant_group_id` are sibling variants for the same
// target. Approving (or sending) one variant cascade-rejects the others with
// reason `variant_lost`. This file is the single source of truth for both the
// CLI (drafts:create grouping) and the web API (approve cascade).
import { and, eq, inArray, ne } from 'drizzle-orm';
import type { Db } from './db/client.js';
import { drafts, draftEvents } from './db/schema.js';

// Labels are assigned A, B, C, ... up to 26; anything beyond falls back to a
// numeric suffix (Z27, Z28, ...). 26 is plenty for human review.
export function variantLabelFor(index: number): string {
  if (index < 0) return '?';
  if (index < 26) return String.fromCharCode(65 + index);
  return `Z${index + 1}`;
}

export interface VariantSeed {
  body: string;
  metadata?: Record<string, unknown>;
}

export interface GroupedVariants {
  variantGroupId: string;
  rows: Array<VariantSeed & { variantLabel: string; variantGroupId: string }>;
}

// Build a (groupId, rows-with-labels) tuple for N>=2 sibling variants. For a
// single body the caller should skip grouping entirely; we still accept N=1
// so the CLI can call this uniformly when a `variants` array is provided.
export function groupVariants(bodies: VariantSeed[], groupId?: string): GroupedVariants {
  const id = groupId ?? cryptoRandomUUID();
  return {
    variantGroupId: id,
    rows: bodies.map((b, i) => ({
      ...b,
      variantGroupId: id,
      variantLabel: variantLabelFor(i),
    })),
  };
}

// Wrapper so the helper works in Node ≥16 and tests without polyfills.
function cryptoRandomUUID(): string {
  const g = globalThis as unknown as { crypto?: { randomUUID?: () => string } };
  if (g.crypto?.randomUUID) return g.crypto.randomUUID();
  // Fallback — only hit in environments without WebCrypto.
  const hex = (n: number) =>
    Math.floor(Math.random() * 16 ** n)
      .toString(16)
      .padStart(n, '0');
  return `${hex(8)}-${hex(4)}-4${hex(3)}-8${hex(3)}-${hex(12)}`;
}

export interface CascadeRejectResult {
  rejectedIds: number[];
  variantGroupId: string;
}

// Reject every sibling of `winningDraftId` in the same variant group.
// Idempotent: drafts already in a non-pending state are skipped.
export async function cascadeRejectSiblings(
  db: Db,
  variantGroupId: string,
  winningDraftId: number,
  actor: 'user' | 'system' = 'system',
): Promise<CascadeRejectResult> {
  const siblings = await db
    .select({ id: drafts.id, state: drafts.state })
    .from(drafts)
    .where(
      and(
        eq(drafts.variantGroupId, variantGroupId),
        ne(drafts.id, winningDraftId),
        inArray(drafts.state, ['pending_review', 'proposed']),
      ),
    );
  if (siblings.length === 0) {
    return { rejectedIds: [], variantGroupId };
  }
  const ids = siblings.map((s) => s.id);
  const now = new Date();
  await db
    .update(drafts)
    .set({ state: 'rejected', reviewedAt: now })
    .where(inArray(drafts.id, ids));
  await db.insert(draftEvents).values(
    ids.map((draftId) => ({
      draftId,
      event: 'rejected',
      actor,
      details: { reason: 'variant_lost', winningDraftId, variantGroupId },
    })),
  );
  return { rejectedIds: ids, variantGroupId };
}
