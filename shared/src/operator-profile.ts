// The DB layer for the operator's own persona and voice samples (LI-21,
// decided 2026-09-07): the operator_profiles/operator_voice_samples tables
// (see shared/src/db/schema.ts's own doc comments on both), read back by
// shared/src/assist/context.ts for the companion prompt and written by two
// callers - the extension's passive capture
// (web/src/routes/api/extension/operator-profile/+server.ts) and a human
// editing Settings directly. Neither talks to drizzle for these tables on
// its own; both go through here, so "never clobber a manual edit without
// being asked" only has to be implemented once.

import { and, desc, eq } from 'drizzle-orm';
import { schema, type Db } from './db/client.js';

export type OperatorProfileSource = 'linkedin_capture' | 'manual';

export type OperatorProfileExperience = {
  title?: string;
  company?: string;
  period?: string;
  summary?: string;
};

export type OperatorProfileRow = {
  id: number;
  organizationId: number;
  handle: string | null;
  displayName: string | null;
  headline: string | null;
  about: string | null;
  experiences: OperatorProfileExperience[];
  notes: string | null;
  source: OperatorProfileSource;
  capturedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type OperatorVoiceSampleRow = {
  id: number;
  organizationId: number;
  externalId: string;
  platformId: number;
  text: string;
  url: string | null;
  postedAt: Date | null;
  excluded: boolean;
  capturedAt: Date;
};

export async function loadOperatorProfile(
  db: Db,
  organizationId: number,
): Promise<OperatorProfileRow | null> {
  const [row] = await db
    .select()
    .from(schema.operatorProfiles)
    .where(eq(schema.operatorProfiles.organizationId, organizationId))
    .limit(1);
  return (row as OperatorProfileRow | undefined) ?? null;
}

export type OperatorProfilePatch = {
  handle?: string | null;
  displayName?: string | null;
  headline?: string | null;
  about?: string | null;
  experiences?: OperatorProfileExperience[];
  notes?: string | null;
  /** Defaults to `'linkedin_capture'` - the extension is the frequent caller;
   * Settings' own save action passes `'manual'` explicitly. */
  source?: OperatorProfileSource;
};

/**
 * Insert-or-update the organization's one `operator_profiles` row.
 *
 * A row already on file with `source: 'manual'` is left untouched by an
 * incoming `patch.source !== 'manual'` (i.e. a passive capture) unless
 * `opts.overwrite` is `true` - the human's own hand-edited persona is never
 * silently replaced by whatever page the extension happened to read next.
 * A manual-to-manual save (Settings re-saving its own form) always applies;
 * there is nothing to protect a manual row from except an automated
 * capture. Fields absent from `patch` are left as they were - this is a
 * partial update, not a full replace.
 */
export async function saveOperatorProfile(
  db: Db,
  organizationId: number,
  patch: OperatorProfilePatch,
  opts: { overwrite?: boolean } = {},
): Promise<OperatorProfileRow> {
  const existing = await loadOperatorProfile(db, organizationId);
  const incomingSource: OperatorProfileSource = patch.source ?? 'linkedin_capture';

  if (existing && existing.source === 'manual' && incomingSource !== 'manual' && !opts.overwrite) {
    return existing;
  }

  // Only a capture bumps capturedAt - a manual edit did not come off a page.
  const capturedAt = incomingSource === 'linkedin_capture' ? new Date() : undefined;

  if (!existing) {
    const [row] = await db
      .insert(schema.operatorProfiles)
      .values({
        organizationId,
        ...patch,
        source: incomingSource,
        capturedAt: capturedAt ?? null,
      })
      .returning();
    return row as OperatorProfileRow;
  }

  const [row] = await db
    .update(schema.operatorProfiles)
    .set({
      ...patch,
      source: incomingSource,
      ...(capturedAt ? { capturedAt } : {}),
      updatedAt: new Date(),
    })
    .where(eq(schema.operatorProfiles.organizationId, organizationId))
    .returning();
  return row as OperatorProfileRow;
}

/** Every voice sample for `organizationId`, newest post first, excluded ones
 * included - Settings shows an excluded sample struck through rather than
 * hiding it, so the human can see what a later capture would otherwise
 * silently bring back (see `operator_voice_samples.excluded`'s own doc
 * comment in schema.ts). */
export async function listVoiceSamples(
  db: Db,
  organizationId: number,
): Promise<OperatorVoiceSampleRow[]> {
  const rows = await db
    .select()
    .from(schema.operatorVoiceSamples)
    .where(eq(schema.operatorVoiceSamples.organizationId, organizationId))
    .orderBy(desc(schema.operatorVoiceSamples.postedAt));
  return rows as OperatorVoiceSampleRow[];
}

/** Org-scoped: a sample id from another organization is a silent no-op, not
 * an error - the same posture as `assertDraftInDeviceOrg`'s cross-tenant
 * guard, since a caller here is always acting on behalf of one org. */
export async function setVoiceSampleExcluded(
  db: Db,
  organizationId: number,
  sampleId: number,
  excluded: boolean,
): Promise<void> {
  await db
    .update(schema.operatorVoiceSamples)
    .set({ excluded })
    .where(
      and(
        eq(schema.operatorVoiceSamples.id, sampleId),
        eq(schema.operatorVoiceSamples.organizationId, organizationId),
      ),
    );
}

export type IncomingVoiceSample = {
  externalId: string;
  text: string;
  url?: string | null;
  postedAt?: string | null;
};

/**
 * Inserts every sample not already on file, deduped on
 * `(organization_id, external_id)` via `ON CONFLICT DO NOTHING` - a
 * re-capture of a `recent-activity` page the human scrolled through before
 * must not grow the table, and an existing sample's `excluded` flag (set by
 * hand in Settings) must not be reset by seeing the same post again.
 * Returns how many rows actually landed, for the activity-log line the
 * caller writes.
 */
export async function recordVoiceSamples(
  db: Db,
  organizationId: number,
  platformId: number,
  samples: IncomingVoiceSample[],
): Promise<number> {
  if (samples.length === 0) return 0;
  const inserted = await db
    .insert(schema.operatorVoiceSamples)
    .values(
      samples.map((s) => ({
        organizationId,
        platformId,
        externalId: s.externalId,
        text: s.text,
        url: s.url ?? null,
        postedAt: s.postedAt ? new Date(s.postedAt) : null,
      })),
    )
    .onConflictDoNothing({
      target: [schema.operatorVoiceSamples.organizationId, schema.operatorVoiceSamples.externalId],
    })
    .returning({ id: schema.operatorVoiceSamples.id });
  return inserted.length;
}
