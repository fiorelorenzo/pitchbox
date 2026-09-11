// The DB layer for the operator's derived voice profile (#407, extended by
// #570/#571): operator_voice_profiles (see shared/src/db/schema.ts's own doc
// comment on the table). Gathers the corpus (voice samples, sent messages,
// sent drafts, project templates - every one org-scoped), hands it to the
// pure measurement in `assist/voice-profile.ts`, and stores the result the
// same way `operator-profile.ts` stores the persona: a `source` of 'derived'
// or 'manual' so a hand-edited summary survives a later refresh until the
// human explicitly resets it.
//
// 2026-09-09 (#570/#571): two additions, both without a schema change -
// nobody in this wave holds the migration slot, and `evidence` was already
// schemaless jsonb, which is what makes both possible:
//
// - Versioned, and readable across versions. `evidence.version` is a
//   per-org counter that increments on every real derivation (never on a
//   manual edit, which does not re-derive anything) - a recompute is
//   provably a new version rather than a silent overwrite, which is what
//   makes a change in output explainable and a stale profile detectable.
//   A row written before this shipped carries no `version` and none of the
//   six new measurement axes; `normalizeEvidence` reads it as version 0
//   with every new axis present as a valid empty measurement rather than
//   throwing - an older profile stays readable, it does not have to be
//   re-derived to be loaded.
// - `resolveVoiceProfile`/`resolveOperatorVoiceProfile` answer "what should
//   the model be told about how the operator writes" honestly: the real
//   measurement once the corpus clears `MIN_ITEMS_TO_DERIVE`,
//   `DEFAULT_VOICE_PROFILE` (#571) otherwise - never a blend, and always
//   labelled which one it is, axis by axis, so a caller can never present a
//   default as if it were measured.

import { and, desc, eq, isNotNull } from 'drizzle-orm';
import { schema, type Db } from './db/client.js';
import {
  measureVoiceCorpus,
  measureVoiceCorpusByGenre,
  describeVoiceProfile,
  describeVoiceProfileForGenre,
  MIN_ITEMS_TO_DERIVE,
  VOICE_CORPUS_ITEM_GENRES,
  type VoiceCorpusItem,
  type VoiceCorpusItemGenre,
  type RhythmProfile,
  type PunctuationProfile,
  type ShapeProfile,
  type VoiceMarkerProfile,
  type LexiconProfile,
  type LanguageProfile,
} from './assist/voice-profile.js';
import {
  EMPTY_RHYTHM,
  EMPTY_PUNCTUATION,
  EMPTY_SHAPE,
  EMPTY_VOICE_MARKERS,
  EMPTY_LEXICON,
  EMPTY_LANGUAGE,
} from './assist/voice-profile.js';
import { DEFAULT_VOICE_PROFILE, type DefaultVoiceProfile } from './assist/voice-defaults.js';
import type { RegisterTrait } from './assist/register.js';

export type OperatorVoiceProfileSource = 'derived' | 'manual';

/** What the corpus gather actually read: which rows, and how many per
 * source. Separate from `VoiceProfileEvidence` below so the DB query layer
 * and the stored-row shape are not the same type by accident. */
export type VoiceCorpusProvenance = {
  voiceSampleIds: number[];
  messageIds: number[];
  draftIds: number[];
  templateIds: number[];
  counts: { voiceSamples: number; messages: number; drafts: number; templates: number };
};

/** One genre's own share of the derivation, alongside the pooled one -
 * "his comments run 2 sentences and open with a concrete noun; his posts
 * run 5" needs its own prose per genre, not one description averaged
 * across both (LOR-223). `measurable: false` and `summary: null` mean
 * exactly what they mean on the pooled `VoiceMeasurement`: this genre has
 * not cleared `MIN_ITEMS_TO_DERIVE` yet, so nothing here is a guess. */
export type VoiceGenreSummary = {
  summary: string | null;
  itemCount: number;
  measurable: boolean;
};

/** What a stored row carries about its own derivation: the provenance
 * above, the format version it was derived with (#570), the six extended
 * measurement axes, and (LOR-223) each genre's own summary - stored here
 * rather than in a new column because `evidence` is already schemaless
 * jsonb and nobody in this wave but LOR-223 holds the migration slot, and
 * LOR-223's own slot went to the columns the genre itself is read from,
 * not to a second jsonb shape. */
export type VoiceProfileEvidence = VoiceCorpusProvenance & {
  version: number;
  rhythm: RhythmProfile;
  punctuation: PunctuationProfile;
  shape: ShapeProfile;
  voiceMarkers: VoiceMarkerProfile;
  lexicon: LexiconProfile;
  language: LanguageProfile;
  genres: Record<VoiceCorpusItemGenre, VoiceGenreSummary>;
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

const EMPTY_PROVENANCE: VoiceCorpusProvenance = {
  voiceSampleIds: [],
  messageIds: [],
  draftIds: [],
  templateIds: [],
  counts: { voiceSamples: 0, messages: 0, drafts: 0, templates: 0 },
};

const EMPTY_GENRE_SUMMARY: VoiceGenreSummary = { summary: null, itemCount: 0, measurable: false };

const EMPTY_GENRE_SUMMARIES: Record<VoiceCorpusItemGenre, VoiceGenreSummary> = {
  post: EMPTY_GENRE_SUMMARY,
  comment: EMPTY_GENRE_SUMMARY,
  reply: EMPTY_GENRE_SUMMARY,
};

const EMPTY_EVIDENCE: VoiceProfileEvidence = {
  ...EMPTY_PROVENANCE,
  version: 0,
  rhythm: EMPTY_RHYTHM,
  punctuation: EMPTY_PUNCTUATION,
  shape: EMPTY_SHAPE,
  voiceMarkers: EMPTY_VOICE_MARKERS,
  lexicon: EMPTY_LEXICON,
  language: EMPTY_LANGUAGE,
  genres: EMPTY_GENRE_SUMMARIES,
};

/** Reads a stored `evidence` blob back into the current full shape,
 * whichever version wrote it. A field absent from the stored JSON (a row
 * from before #570, or before #407 for `counts`/the id arrays, or before
 * LOR-223 for `genres`) reads as this axis's empty value rather than
 * `undefined` - the loader never throws on an older profile, and never
 * invents a measurement for an axis that was never derived. */
function normalizeEvidence(raw: unknown): VoiceProfileEvidence {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<VoiceProfileEvidence>;
  return {
    version: typeof r.version === 'number' ? r.version : 0,
    voiceSampleIds: r.voiceSampleIds ?? [],
    messageIds: r.messageIds ?? [],
    draftIds: r.draftIds ?? [],
    templateIds: r.templateIds ?? [],
    counts: r.counts ?? EMPTY_PROVENANCE.counts,
    rhythm: r.rhythm ?? EMPTY_RHYTHM,
    punctuation: r.punctuation ?? EMPTY_PUNCTUATION,
    shape: r.shape ?? EMPTY_SHAPE,
    voiceMarkers: r.voiceMarkers ?? EMPTY_VOICE_MARKERS,
    lexicon: r.lexicon ?? EMPTY_LEXICON,
    language: r.language ?? EMPTY_LANGUAGE,
    genres: r.genres ?? EMPTY_GENRE_SUMMARIES,
  };
}

function toRow(raw: unknown): OperatorVoiceProfileRow {
  const r = raw as OperatorVoiceProfileRow;
  return { ...r, evidence: normalizeEvidence(r.evidence) };
}

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
  return row ? toRow(row) : null;
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
): Promise<{ corpus: VoiceCorpusItem[]; evidence: VoiceCorpusProvenance }> {
  const [sampleRows, messageRows, draftRows, templateRows] = await Promise.all([
    db
      .select({
        id: schema.operatorVoiceSamples.id,
        text: schema.operatorVoiceSamples.text,
        genre: schema.operatorVoiceSamples.genre,
      })
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
    ...sampleRows.map((r) => ({
      id: r.id,
      kind: 'voice_sample' as const,
      genre: r.genre as VoiceCorpusItemGenre,
      text: r.text,
    })),
    ...messageRows.map((r) => ({ id: r.id, kind: 'message' as const, text: r.text })),
    ...draftRows.map((r) => ({ id: r.id, kind: 'draft' as const, text: r.sentContent ?? r.body })),
    ...templateRows.map((r) => ({ id: r.id, kind: 'template' as const, text: r.text })),
  ];

  const evidence: VoiceCorpusProvenance = {
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
 *
 * `evidence.version` increments on every call that reaches this far,
 * regardless of whether the resulting measurement is byte-identical to the
 * last one - the counter tracks derivation events, not content changes, so
 * "the same evidence produces the same profile" (determinism) and "a
 * recompute is a new version" are both true at once rather than in
 * tension.
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

  const { corpus, evidence: provenance } = await gatherVoiceCorpus(db, organizationId);
  const measurement = measureVoiceCorpus(corpus);
  const summary = describeVoiceProfile(measurement) ?? '';

  // LOR-223: each genre measured on its own, alongside the pooled corpus
  // above - "his comments run 2 sentences and open with a concrete noun;
  // his posts run 5" needs a per-genre description, not the pooled one
  // repeated. A message/draft/template carries no genre and never enters
  // any of these three buckets - see VoiceCorpusItemGenre's own comment.
  const measurementByGenre = measureVoiceCorpusByGenre(corpus);
  const genres = {} as VoiceProfileEvidence['genres'];
  for (const genre of VOICE_CORPUS_ITEM_GENRES) {
    const genreMeasurement = measurementByGenre[genre];
    genres[genre] = {
      summary: describeVoiceProfileForGenre(genre, genreMeasurement),
      itemCount: genreMeasurement.itemCount,
      measurable: genreMeasurement.measurable,
    };
  }

  const evidence: VoiceProfileEvidence = {
    ...provenance,
    version: (existing?.evidence.version ?? 0) + 1,
    rhythm: measurement.rhythm,
    punctuation: measurement.punctuation,
    shape: measurement.shape,
    voiceMarkers: measurement.voiceMarkers,
    lexicon: measurement.lexicon,
    language: measurement.language,
    genres,
  };

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
    return toRow(row);
  }

  const [row] = await db
    .update(schema.operatorVoiceProfiles)
    .set({ ...values, updatedAt: new Date() })
    .where(eq(schema.operatorVoiceProfiles.organizationId, organizationId))
    .returning();
  return toRow(row);
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
    return toRow(row);
  }

  const [row] = await db
    .update(schema.operatorVoiceProfiles)
    .set({ summary: trimmed, source: 'manual', updatedAt: new Date() })
    .where(eq(schema.operatorVoiceProfiles.organizationId, organizationId))
    .returning();
  return toRow(row);
}

/** Discards a manual edit and forces a fresh derivation, even over a
 * `source: 'manual'` row - Settings' explicit "Reset to derived" action. */
export async function resetVoiceProfileToDerived(
  db: Db,
  organizationId: number,
): Promise<OperatorVoiceProfileRow> {
  return refreshVoiceProfile(db, organizationId, { overwrite: true });
}

// ---------------------------------------------------------------------------
// #571: resolving "how the operator writes" honestly - the real measurement
// once there is enough of it, DEFAULT_VOICE_PROFILE otherwise, always
// labelled which one a caller is looking at.
// ---------------------------------------------------------------------------

export type VoiceProfileAxisStatus = 'measured' | 'default';

export type VoiceAxis =
  'rhythm' | 'punctuation' | 'shape' | 'voiceMarkers' | 'lexicon' | 'language';

export const VOICE_AXES: readonly VoiceAxis[] = [
  'rhythm',
  'punctuation',
  'shape',
  'voiceMarkers',
  'lexicon',
  'language',
];

export type ResolvedOperatorVoiceProfile = {
  organizationId: number;
  /** 'measured' once a row on file cleared MIN_ITEMS_TO_DERIVE; 'default'
   * for a thin or absent corpus. Never invented - the design doc's rule for
   * the operator_voice tool (#567): thin evidence gets the defaults from
   * #571, never a profile derived from nothing. */
  status: 'measured' | 'default';
  summary: string;
  /** Every axis labelled the same way as `status`. Its own field, not just
   * a restatement of `status`, so a caller has one place to check before
   * rendering any single axis as a measurement. */
  axes: Record<VoiceAxis, VoiceProfileAxisStatus>;
  /** The stored row, present only when `status` is 'measured'. */
  measured: OperatorVoiceProfileRow | null;
  defaults: DefaultVoiceProfile;
  version: number;
  derivedAt: string | null;
  itemCount: number;
  /** What a thin corpus still needs, e.g. "2 more pieces of their own
   * writing...". Null once `status` is 'measured'. */
  gap: string | null;
};

const MEASURED_AXES: Record<VoiceAxis, VoiceProfileAxisStatus> = {
  rhythm: 'measured',
  punctuation: 'measured',
  shape: 'measured',
  voiceMarkers: 'measured',
  lexicon: 'measured',
  language: 'measured',
};

const DEFAULT_AXES: Record<VoiceAxis, VoiceProfileAxisStatus> = {
  rhythm: 'default',
  punctuation: 'default',
  shape: 'default',
  voiceMarkers: 'default',
  lexicon: 'default',
  language: 'default',
};

function describeVoiceProfileGap(itemCount: number): string {
  const needed = MIN_ITEMS_TO_DERIVE - itemCount;
  const piece = needed === 1 ? 'piece' : 'pieces';
  return `${needed} more ${piece} of their own writing (a post, a sent message or a sent draft) and this can start measuring their habits instead of defaulting.`;
}

/**
 * Resolves what the model and the operator should be told about how the
 * operator writes: the stored measurement once the corpus has cleared
 * `MIN_ITEMS_TO_DERIVE`, `DEFAULT_VOICE_PROFILE` otherwise - never a blend
 * of the two. Pure: takes an already-loaded row, so it is unit-testable
 * without a database and without a model call anywhere in reach.
 */
export function resolveVoiceProfile(
  organizationId: number,
  row: OperatorVoiceProfileRow | null,
): ResolvedOperatorVoiceProfile {
  const itemCount = row?.itemCount ?? 0;

  if (row && itemCount >= MIN_ITEMS_TO_DERIVE) {
    return {
      organizationId,
      status: 'measured',
      summary: row.summary,
      axes: MEASURED_AXES,
      measured: row,
      defaults: DEFAULT_VOICE_PROFILE,
      version: row.evidence.version,
      derivedAt: row.derivedAt ? row.derivedAt.toISOString() : null,
      itemCount,
      gap: null,
    };
  }

  return {
    organizationId,
    status: 'default',
    summary: DEFAULT_VOICE_PROFILE.summary,
    axes: DEFAULT_AXES,
    measured: null,
    defaults: DEFAULT_VOICE_PROFILE,
    version: row?.evidence.version ?? 0,
    derivedAt: row?.derivedAt ? row.derivedAt.toISOString() : null,
    itemCount,
    gap: describeVoiceProfileGap(itemCount),
  };
}

/** `resolveVoiceProfile`, loading the row itself - what a caller reaches
 * for in practice (the operator_voice tool, #567; Settings). */
export async function resolveOperatorVoiceProfile(
  db: Db,
  organizationId: number,
): Promise<ResolvedOperatorVoiceProfile> {
  const row = await loadVoiceProfile(db, organizationId);
  return resolveVoiceProfile(organizationId, row);
}
