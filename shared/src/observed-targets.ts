// Ingest for posts the browser observed on linkedin.com outside of any
// campaign run. See docs/linkedin-integration-design.md ("Observation
// collection" / "Storage" / "Two frontends, one identifier") and issue #300.
//
// The caller (POST /api/extension/observations, #301) resolves the
// authenticated device's organization and the destination project; this
// module only validates, normalises and writes the batch it is handed.
// Malformed entries (a missing/empty external_id or url, or an unparsable
// observed_at) are dropped individually rather than failing the whole
// batch - the extension builds these from raw DOM reads, so one degenerate
// sighting must not lose the rest of a debounce tick (same posture as
// IncomingDmSchema in web/src/routes/api/extension/dm-sync/+server.ts).
//
// Dedup is `onConflictDoNothing` against `observed_targets_dedup_idx`
// (organization_id, platform_id, external_id), a full (non-partial) unique
// index, so a repeat sighting of an already-consumed post is also a no-op
// rather than resurrecting it - see the verifying-on-conflict-dedupe skill.

import { z } from 'zod';
import { and, desc, eq, isNotNull } from 'drizzle-orm';
import type { Db } from './db/client.js';
import { observedTargets } from './db/schema.js';

// A legitimate batch is one debounce tick's worth of posts scrolled past -
// at most a couple dozen. This bounds a malformed or hostile payload from
// forcing an unbounded amount of DB work per call (mirrors dm-sync's
// MAX_BATCH_SIZE in web/src/routes/api/extension/dm-sync/+server.ts).
export const MAX_OBSERVED_TARGETS_BATCH = 200;

const ObservationSchema = z.object({
  // The stable per-frontend identifier (an activity or comment URN on
  // LinkedIn today; see "Two frontends, one identifier" in the design doc).
  // A sighting with none is not dedupable - the collector must only call
  // this service for a post the human actually opened.
  externalId: z.string().trim().min(1),
  url: z.url(),
  // Optional context fields: validated as strings when present (so a
  // non-string value is still malformed), but an empty/whitespace-only
  // value normalises to null below rather than rejecting the whole entry -
  // author and text are context, not part of the dedup key.
  authorHandle: z.string().nullish(),
  authorName: z.string().nullish(),
  text: z.string().nullish(),
  observedAt: z.string().refine((v) => !Number.isNaN(Date.parse(v)), { message: 'invalid date' }),
});

export type RawObservedTarget = z.input<typeof ObservationSchema>;
export type ObservedTargetRow = typeof observedTargets.$inferSelect;

export interface IngestObservedTargetsInput {
  organizationId: number;
  projectId: number;
  platformId: number;
  observations: unknown[];
}

export interface IngestObservedTargetsResult {
  /** Rows actually inserted (post-validation, post-dedup). */
  written: ObservedTargetRow[];
  /** Entries dropped for failing per-item validation. */
  rejected: number;
}

function normaliseOptionalText(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Validate, normalise and insert a batch of browser-observed LinkedIn posts.
 * Throws only when the batch itself exceeds `MAX_OBSERVED_TARGETS_BATCH`;
 * a malformed individual entry is dropped, not thrown, and counted in
 * `rejected`. Insert is a single statement so ON CONFLICT DO NOTHING also
 * dedupes entries within the same batch against each other, not just
 * against rows already in the table.
 */
export async function ingestObservedTargets(
  db: Db,
  input: IngestObservedTargetsInput,
): Promise<IngestObservedTargetsResult> {
  const { organizationId, projectId, platformId, observations } = input;
  if (observations.length > MAX_OBSERVED_TARGETS_BATCH) {
    throw new Error(
      `observed targets batch of ${observations.length} exceeds the ${MAX_OBSERVED_TARGETS_BATCH} cap`,
    );
  }

  let rejected = 0;
  const values: (typeof observedTargets.$inferInsert)[] = [];
  for (const raw of observations) {
    const parsed = ObservationSchema.safeParse(raw);
    if (!parsed.success) {
      rejected++;
      continue;
    }
    values.push({
      organizationId,
      projectId,
      platformId,
      externalId: parsed.data.externalId,
      url: parsed.data.url,
      authorHandle: normaliseOptionalText(parsed.data.authorHandle),
      authorName: normaliseOptionalText(parsed.data.authorName),
      text: normaliseOptionalText(parsed.data.text),
      observedAt: new Date(parsed.data.observedAt),
    });
  }

  if (values.length === 0) {
    return { written: [], rejected };
  }

  const written = await db
    .insert(observedTargets)
    .values(values)
    .onConflictDoNothing({
      target: [
        observedTargets.organizationId,
        observedTargets.platformId,
        observedTargets.externalId,
      ],
    })
    .returning();

  return { written, rejected };
}

/**
 * The single most recently observed post with readable text, for `projectId`
 * on `platformId`. What `POST /api/extension/suggest` grounds a `kind: 'post'`
 * suggestion in (#315): the post composer itself has nothing to riff off - it
 * is a blank box, not a post the human is reading - so a `post` suggestion is
 * grounded server-side in what the observation buffer (#301/#302) already
 * collected while the human scrolled, rather than the panel handing over
 * whatever it could scrape live off the page it happens to be on. Ignores
 * `consumedByRunId`: a scout-candidate drain (#304) consuming a row for a
 * campaign has nothing to do with whether that sighting is still recent
 * enough to ground a suggestion. Text-less sightings (a real, documented gap
 * - see `linkedin-dom.ts`'s "What is checked against a real capture") are
 * excluded, since there is nothing in them to draft from.
 */
export async function loadRecentObservedTarget(
  db: Db,
  input: { organizationId: number; projectId: number; platformId: number },
): Promise<{
  authorHandle: string | null;
  authorName: string | null;
  text: string;
  url: string;
} | null> {
  const [row] = await db
    .select({
      authorHandle: observedTargets.authorHandle,
      authorName: observedTargets.authorName,
      text: observedTargets.text,
      url: observedTargets.url,
    })
    .from(observedTargets)
    .where(
      and(
        // Organization as well as project, even though a project belongs to
        // exactly one organization and the caller has already checked it:
        // `organization_id` is carried on this row directly for precisely
        // this reason (#263), and a read that has to be reasoned about to be
        // safe is one somebody will get wrong later.
        eq(observedTargets.organizationId, input.organizationId),
        eq(observedTargets.projectId, input.projectId),
        eq(observedTargets.platformId, input.platformId),
        isNotNull(observedTargets.text),
      ),
    )
    .orderBy(desc(observedTargets.observedAt))
    .limit(1);
  if (!row || !row.text) return null;
  return {
    authorHandle: row.authorHandle,
    authorName: row.authorName,
    text: row.text,
    url: row.url,
  };
}
