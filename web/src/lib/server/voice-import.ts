// The server-side glue for a LinkedIn "Get a copy of your data" export
// import, shared between LOR-245's `POST /api/extension/voice-import` and
// (once wired) the companion/voice page's own `importVoice` form action -
// same reason `parseLinkedinExportBuffer` itself is shared between the CLI
// and that page (LOR-223): two callers persisting the same parsed export
// must not drift into two different notions of "imported" or "duplicate".
//
// This file owns the one thing neither existing caller needed until now:
// turning `parseLinkedinExportBufferWithStats`'s per-genre row counts and
// `importVoiceSamples`'s per-genre insert counts into a full accounting of
// what happened to every row in the file - landed, duplicate, or dropped
// as a textless repost/reaction - plus the corpus's post-import
// `MIN_ITEMS_TO_DERIVE` status per genre. `{ok:true}` is not an answer for
// an automating caller; this is what actually is one.

import { eq } from 'drizzle-orm';
import { schema, type Db } from './db.js';
import { parseLinkedinExportBufferWithStats } from '@pitchbox/shared/voice-import-archive';
import { importVoiceSamples, importVoiceMessages } from '@pitchbox/shared/operator-profile';
import {
  loadVoiceProfile,
  refreshVoiceProfile,
  type OperatorVoiceProfileRow,
} from '@pitchbox/shared/operator-voice-profile';

/** Same cap the companion/voice upload form applies (LOR-223's
 * MAX_VOICE_IMPORT_BYTES) - defined here so the API route and that page's
 * form action enforce one number, not two that can silently drift apart. */
export const MAX_VOICE_IMPORT_BYTES = 20 * 1024 * 1024;

type GenreCounts = { post: number; comment: number };
type GenreProfile = { itemCount: number; measurable: boolean };
/** Same shape as `GenreCounts`, but for `messages.csv` (LOR-267) - kept
 * separate rather than widened into `GenreCounts` since a message has no
 * genre (see `voice-import.ts`'s own comment on `ImportedVoiceMessage`). */
type MessageCounts = {
  imported: number;
  duplicates: number;
  skippedNoText: number;
  totalRows: number;
};

export type VoiceImportOutcome = {
  /** New rows actually written, per genre. Zero across the board on a
   * re-post of an export already on file. */
  imported: GenreCounts;
  /** Parsed rows that already existed (same `(organizationId, externalId)`)
   * and were dropped by the insert's own `ON CONFLICT DO NOTHING`. */
  duplicates: GenreCounts;
  /** Rows dropped before ever reaching the corpus: a bare repost in
   * Shares.csv, or a reaction with no written comment in Comments.csv. */
  skippedNoText: GenreCounts;
  /** Every row the file actually had, per genre, whatever happened to it:
   * `imported + duplicates + skippedNoText`, genre by genre. */
  totalRows: GenreCounts;
  /** The operator's own sent DMs from `messages.csv` (LOR-267) - zero
   * across the board when the archive carries no messages.csv.
   * `skippedNoText` here also covers a row from someone else and a draft
   * row, not only an empty body - see `voice-import.ts`'s
   * `parseMessagesCsv` for why those are indistinguishable from the
   * outside: all three are "not this operator's own sent writing". */
  messages: MessageCounts;
  /** True when nothing new landed - the normal outcome of re-posting the
   * same archive, not a failure. */
  noop: boolean;
  /** One human-readable line summarising the outcome above. */
  message: string;
  /** The corpus's `MIN_ITEMS_TO_DERIVE` status per genre after this import
   * (refreshed only when something new landed; otherwise the profile's
   * current, unchanged state). */
  profile: { post: GenreProfile; comment: GenreProfile; reply: GenreProfile };
};

/** The `platforms.id` LinkedIn import rows are filed under, or `null` if
 * the seed data that creates that row was never run. */
export async function resolveLinkedinPlatformId(db: Db): Promise<number | null> {
  const [row] = await db
    .select({ id: schema.platforms.id })
    .from(schema.platforms)
    .where(eq(schema.platforms.slug, 'linkedin'))
    .limit(1);
  return row?.id ?? null;
}

function genreProfile(
  row: OperatorVoiceProfileRow | null,
  genre: 'post' | 'comment' | 'reply',
): GenreProfile {
  const summary = row?.evidence.genres[genre];
  return { itemCount: summary?.itemCount ?? 0, measurable: summary?.measurable ?? false };
}

/**
 * Parses and persists a LinkedIn export buffer (`parseLinkedinExportBuffer`'s
 * own zip-or-CSV dispatch, via the stats-carrying variant) into
 * `organizationId`'s voice corpus, refreshing the derived voice profile
 * only when something new actually landed - a re-post of the same archive
 * must not re-derive (or re-version, see operator-voice-profile.ts's own
 * doc comment on `evidence.version`) a profile that hasn't changed.
 *
 * Throws a readable `Error` for anything that stops the import outright -
 * a file that isn't a recognisable export, or an archive with neither
 * `Shares.csv` nor `Comments.csv` - exactly what `parseLinkedinExportBuffer`
 * itself throws. Callers decide their own status code / response shape
 * around that; `platformId` must already be resolved (a missing LinkedIn
 * platform row is a server misconfiguration, not a bad request, so it's
 * this function's caller's job to tell those apart).
 */
export async function importLinkedinVoiceExport(
  db: Db,
  organizationId: number,
  platformId: number,
  buffer: Buffer,
  filename: string,
): Promise<VoiceImportOutcome> {
  const { items, messages, stats } = parseLinkedinExportBufferWithStats(buffer, filename);
  const [persisted, persistedMessages] = await Promise.all([
    importVoiceSamples(db, organizationId, platformId, items),
    importVoiceMessages(db, organizationId, platformId, messages),
  ]);

  const totalRows: GenreCounts = { post: stats.post.totalRows, comment: stats.comment.totalRows };
  const skippedNoText: GenreCounts = { post: stats.post.skipped, comment: stats.comment.skipped };
  const duplicates: GenreCounts = {
    post: stats.post.imported - persisted.byGenre.post,
    comment: stats.comment.imported - persisted.byGenre.comment,
  };
  const messageCounts: MessageCounts = {
    imported: persistedMessages.inserted,
    duplicates: stats.message.imported - persistedMessages.inserted,
    skippedNoText: stats.message.skipped,
    totalRows: stats.message.totalRows,
  };

  // Onboarding in one step, same as the CLI's own voiceImportRun: a fresh
  // import is exactly the case where the corpus just crossed
  // MIN_ITEMS_TO_DERIVE, so the caller shouldn't have to separately
  // remember to refresh. A pure re-post (nothing inserted anywhere) skips
  // the derivation entirely and just reports the profile's current state.
  const totalInserted = persisted.inserted + persistedMessages.inserted;
  const profileRow =
    totalInserted > 0
      ? await refreshVoiceProfile(db, organizationId)
      : await loadVoiceProfile(db, organizationId);

  const noop = totalInserted === 0;
  const totalParsed = stats.post.imported + stats.comment.imported + stats.message.imported;
  const message = noop
    ? totalParsed === 0
      ? 'Nothing to import: no post, comment or message in this file had any usable text.'
      : `Imported nothing new: all ${totalParsed} parsed item(s) were already on file.`
    : `Imported ${totalInserted} new item(s) (${persisted.byGenre.post} post(s), ${persisted.byGenre.comment} comment(s), ${persistedMessages.inserted} message(s)).`;

  return {
    imported: persisted.byGenre,
    duplicates,
    skippedNoText,
    totalRows,
    messages: messageCounts,
    noop,
    message,
    profile: {
      post: genreProfile(profileRow, 'post'),
      comment: genreProfile(profileRow, 'comment'),
      reply: genreProfile(profileRow, 'reply'),
    },
  };
}
