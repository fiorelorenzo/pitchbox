// The DB layer for the operator's derived voice profile (#407):
// operator_voice_profiles (see shared/src/db/schema.ts's own doc comment on
// the table). Gathers the corpus (voice samples, sent messages, sent
// drafts, project templates - every one org-scoped), hands it to the pure
// measurement in `assist/voice-profile.ts`, and stores the result the same
// way `operator-profile.ts` stores the persona: a `source` of 'derived' or
// 'manual' so a hand-edited summary survives a later refresh until the
// human explicitly resets it.

import { and, desc, eq, isNotNull } from 'drizzle-orm';
import { schema, type Db } from './db/client.js';
import {
  measureVoiceCorpus,
  describeVoiceProfile,
  type VoiceCorpusItem,
} from './assist/voice-profile.js';
import type { RegisterTrait } from './assist/register.js';

export type OperatorVoiceProfileSource = 'derived' | 'manual';

export type VoiceProfileEvidence = {
  voiceSampleIds: number[];
  messageIds: number[];
  draftIds: number[];
  templateIds: number[];
  counts: { voiceSamples: number; messages: number; drafts: number; templates: number };
};

export type OperatorVoiceProfileRow = {
  id: number;
  organizationId: number;
  summary: string;
  traits: RegisterTrait[];
  openings: string[];
  closings: string[];
  commonWords: string[];
  wordsPerSentence: number;
  itemCount: number;
  wordCount: number;
  evidence: VoiceProfileEvidence;
  source: OperatorVoiceProfileSource;
  derivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

const EMPTY_EVIDENCE: VoiceProfileEvidence = {
  voiceSampleIds: [],
  messageIds: [],
  draftIds: [],
  templateIds: [],
  counts: { voiceSamples: 0, messages: 0, drafts: 0, templates: 0 },
};

/** Past this many recent items per source, the derivation does not get any
 * more accurate, only slower - 200 is already an implausibly large corpus
 * for a single early-stage operator, and capping the query keeps a refresh
 * cheap regardless of how large the tables grow. */
export const MAX_CORPUS_ITEMS_PER_SOURCE = 200;

export async function loadVoiceProfile(
  db: Db,
  organizationId: number,
): Promise<OperatorVoiceProfileRow | null> {
  const [row] = await db
    .select()
    .from(schema.operatorVoiceProfiles)
    .where(eq(schema.operatorVoiceProfiles.organizationId, organizationId))
    .limit(1);
  return (row as OperatorVoiceProfileRow | undefined) ?? null;
}

/**
 * Every org-scoped piece of writing the derivation is allowed to read:
 * non-excluded voice samples, outbound messages, sent drafts (their
 * `sent_content` when the human edited before sending, their `body`
 * otherwise - the same fallback the send routes themselves use), and every
 * project's templates. Nothing here crosses an organization boundary: each
 * query filters on `organization_id` directly or through the row's project.
 */
async function gatherVoiceCorpus(
  db: Db,
  organizationId: number,
): Promise<{ corpus: VoiceCorpusItem[]; evidence: VoiceProfileEvidence }> {
  const [sampleRows, messageRows, draftRows, templateRows] = await Promise.all([
    db
      .select({ id: schema.operatorVoiceSamples.id, text: schema.operatorVoiceSamples.text })
      .from(schema.operatorVoiceSamples)
      .where(
        and(
          eq(schema.operatorVoiceSamples.organizationId, organizationId),
          eq(schema.operatorVoiceSamples.excluded, false),
        ),
      )
      .orderBy(desc(schema.operatorVoiceSamples.postedAt))
      .limit(MAX_CORPUS_ITEMS_PER_SOURCE),
    db
      .select({ id: schema.messages.id, text: schema.messages.body })
      .from(schema.messages)
      .innerJoin(schema.contactHistory, eq(schema.contactHistory.id, schema.messages.contactId))
      .where(
        and(
          eq(schema.contactHistory.organizationId, organizationId),
          eq(schema.messages.isFromUs, true),
        ),
      )
      .orderBy(desc(schema.messages.createdAtPlatform))
      .limit(MAX_CORPUS_ITEMS_PER_SOURCE),
    db
      .select({
        id: schema.drafts.id,
        body: schema.drafts.body,
        sentContent: schema.drafts.sentContent,
      })
      .from(schema.drafts)
      .innerJoin(schema.projects, eq(schema.projects.id, schema.drafts.projectId))
      .where(
        and(eq(schema.projects.organizationId, organizationId), isNotNull(schema.drafts.sentAt)),
      )
      .orderBy(desc(schema.drafts.sentAt))
      .limit(MAX_CORPUS_ITEMS_PER_SOURCE),
    db
      .select({ id: schema.templates.id, text: schema.templates.body })
      .from(schema.templates)
      .innerJoin(schema.projects, eq(schema.projects.id, schema.templates.projectId))
      .where(eq(schema.projects.organizationId, organizationId))
      .orderBy(desc(schema.templates.updatedAt))
      .limit(MAX_CORPUS_ITEMS_PER_SOURCE),
  ]);

  const corpus: VoiceCorpusItem[] = [
    ...sampleRows.map((r) => ({ id: r.id, kind: 'voice_sample' as const, text: r.text })),
    ...messageRows.map((r) => ({ id: r.id, kind: 'message' as const, text: r.text })),
    ...draftRows.map((r) => ({ id: r.id, kind: 'draft' as const, text: r.sentContent ?? r.body })),
    ...templateRows.map((r) => ({ id: r.id, kind: 'template' as const, text: r.text })),
  ];

  const evidence: VoiceProfileEvidence = {
    voiceSampleIds: sampleRows.map((r) => r.id),
    messageIds: messageRows.map((r) => r.id),
    draftIds: draftRows.map((r) => r.id),
    templateIds: templateRows.map((r) => r.id),
    counts: {
      voiceSamples: sampleRows.length,
      messages: messageRows.length,
      drafts: draftRows.length,
      templates: templateRows.length,
    },
  };

  return { corpus, evidence };
}

/**
 * Re-derives the voice profile from the current corpus and stores it.
 *
 * A row already on file with `source: 'manual'` is left untouched
 * (`opts.overwrite` not set) - the same protection `saveOperatorProfile`
 * gives the persona, for the same reason: a human corrected a wrong
 * derivation, and a passive refresh must not silently discard that. Pass
 * `overwrite: true` (Settings' "Reset to derived" action) to force a fresh
 * derivation over a manual edit.
 */
export async function refreshVoiceProfile(
  db: Db,
  organizationId: number,
  opts: { overwrite?: boolean } = {},
): Promise<OperatorVoiceProfileRow> {
  const existing = await loadVoiceProfile(db, organizationId);
  if (existing && existing.source === 'manual' && !opts.overwrite) {
    return existing;
  }

  const { corpus, evidence } = await gatherVoiceCorpus(db, organizationId);
  const measurement = measureVoiceCorpus(corpus);
  const summary = describeVoiceProfile(measurement) ?? '';

  const values = {
    organizationId,
    summary,
    traits: measurement.traits,
    openings: measurement.openings,
    closings: measurement.closings,
    commonWords: measurement.commonWords,
    wordsPerSentence: measurement.wordsPerSentence,
    itemCount: measurement.itemCount,
    wordCount: measurement.wordCount,
    evidence,
    source: 'derived' as const,
    derivedAt: new Date(),
  };

  if (!existing) {
    const [row] = await db.insert(schema.operatorVoiceProfiles).values(values).returning();
    return row as OperatorVoiceProfileRow;
  }

  const [row] = await db
    .update(schema.operatorVoiceProfiles)
    .set({ ...values, updatedAt: new Date() })
    .where(eq(schema.operatorVoiceProfiles.organizationId, organizationId))
    .returning();
  return row as OperatorVoiceProfileRow;
}

/**
 * A human's hand-edited summary, replacing whatever was there (derived or
 * manual) and marking the row `manual` so the next automatic refresh leaves
 * it alone. The measured fields (traits/openings/etc.) and evidence are
 * left as they were - they describe the last real derivation, not this
 * edit, and Settings does not show them once the summary is manual.
 */
export async function saveVoiceProfileSummary(
  db: Db,
  organizationId: number,
  summary: string,
): Promise<OperatorVoiceProfileRow> {
  const trimmed = summary.trim();
  const existing = await loadVoiceProfile(db, organizationId);

  if (!existing) {
    const [row] = await db
      .insert(schema.operatorVoiceProfiles)
      .values({ organizationId, summary: trimmed, evidence: EMPTY_EVIDENCE, source: 'manual' })
      .returning();
    return row as OperatorVoiceProfileRow;
  }

  const [row] = await db
    .update(schema.operatorVoiceProfiles)
    .set({ summary: trimmed, source: 'manual', updatedAt: new Date() })
    .where(eq(schema.operatorVoiceProfiles.organizationId, organizationId))
    .returning();
  return row as OperatorVoiceProfileRow;
}

/** Discards a manual edit and forces a fresh derivation, even over a
 * `source: 'manual'` row - Settings' explicit "Reset to derived" action. */
export async function resetVoiceProfileToDerived(
  db: Db,
  organizationId: number,
): Promise<OperatorVoiceProfileRow> {
  return refreshVoiceProfile(db, organizationId, { overwrite: true });
}
