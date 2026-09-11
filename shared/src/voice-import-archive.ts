// The impure half of the LinkedIn export importer (LOR-223): reading a zip
// or a bare CSV off disk/upload and handing text to the pure parser in
// voice-import.ts. Kept in its own file so voice-import.ts stays pure and
// unit-testable without touching a filesystem.

import AdmZip from 'adm-zip';
import {
  detectCsvKind,
  parseLinkedinVoiceExport,
  parseSharesCsvStats,
  parseCommentsCsvStats,
  parseMessagesCsv,
  parseMessagesCsvStats,
  type ImportedVoiceItem,
  type ImportedVoiceMessage,
  type CsvParseStats,
} from './voice-import.js';

const SHARES_ENTRY = /(?:^|\/)shares\.csv$/iu;
const COMMENTS_ENTRY = /(?:^|\/)comments\.csv$/iu;
const MESSAGES_ENTRY = /(?:^|\/)messages\.csv$/iu;

function decodeUtf8(buffer: Buffer): string {
  let text = buffer.toString('utf8');
  // Strip a UTF-8 BOM - LinkedIn's own export writes one.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return text;
}

/** Reads `Shares.csv`/`Comments.csv`/`messages.csv` out of a LinkedIn "Get
 * a copy of your data" zip, wherever they sit inside it (some export
 * versions nest every CSV under a dated folder). Matches by filename, not
 * by position in the archive.
 *
 * Throws only when the zip carries none of the three (LOR-267): LinkedIn
 * answers a data request with two archives - a "Basic" one within
 * minutes that carries only `messages.csv`, and a second with
 * `Shares.csv`/`Comments.csv` up to 24 hours later - so a zip missing two
 * of the three is the normal, expected shape of the first email, not a
 * bad upload. The message names what the zip actually contained, so a
 * genuinely unusable file (the wrong export, an empty zip) is something a
 * customer can act on rather than a bare "wrong file" reading. */
export function extractLinkedinExportZip(buffer: Buffer): {
  sharesCsv: string | null;
  commentsCsv: string | null;
  messagesCsv: string | null;
} {
  const zip = new AdmZip(buffer);
  let sharesCsv: string | null = null;
  let commentsCsv: string | null = null;
  let messagesCsv: string | null = null;
  const memberNames: string[] = [];
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;
    memberNames.push(entry.entryName);
    if (SHARES_ENTRY.test(entry.entryName)) {
      sharesCsv = decodeUtf8(entry.getData());
    } else if (COMMENTS_ENTRY.test(entry.entryName)) {
      commentsCsv = decodeUtf8(entry.getData());
    } else if (MESSAGES_ENTRY.test(entry.entryName)) {
      messagesCsv = decodeUtf8(entry.getData());
    }
  }
  if (sharesCsv === null && commentsCsv === null && messagesCsv === null) {
    const found =
      memberNames.length > 0
        ? `It contained: ${memberNames.slice(0, 12).join(', ')}${memberNames.length > 12 ? ', ...' : ''}.`
        : 'It was empty.';
    throw new Error(
      `This archive has none of Shares.csv, Comments.csv or messages.csv - the files this importer reads. ${found} Check this is a LinkedIn "Get a copy of your data" export: LinkedIn sends a small archive within minutes and a larger one with your posts and comments up to 24 hours later.`,
    );
  }
  return { sharesCsv, commentsCsv, messagesCsv };
}

/** Per-file `CsvParseStats` for one archive: `post` from `Shares.csv`,
 * `comment` from `Comments.csv`, `message` from `messages.csv` (LOR-267).
 * Zero-valued for a file the export didn't carry at all (a bare CSV
 * upload only ever has one). */
export type LinkedinExportParseStats = {
  post: CsvParseStats;
  comment: CsvParseStats;
  message: CsvParseStats;
};

const EMPTY_STATS: CsvParseStats = { totalRows: 0, imported: 0, skipped: 0 };

/**
 * `parseLinkedinExportBuffer`, plus the row counts LOR-245's API route
 * needs to report an import honestly (rows seen, rows imported, rows
 * skipped as textless reposts/reactions/other-people's-messages/drafts -
 * see `CsvParseStats`), and, since LOR-267, the operator's own sent DMs
 * alongside the posts/comments `items` has always carried.
 *
 * `messages` is a separate field rather than folded into `items`: a DM
 * has no genre and is persisted through its own table
 * (`operator-profile.ts`'s `importVoiceMessages`), so mixing it into
 * `ImportedVoiceItem[]` would either invent a genre that table's `genre`
 * column was never meant to hold, or silently break every existing
 * caller of `items` that assumes `post`/`comment`. Kept separate from
 * `parseLinkedinExportBuffer` rather than changing its return type for
 * the same reason - the CLI and the companion form action only ever
 * wanted the items, and companion's own upload flow is untouched by this
 * addition.
 */
export function parseLinkedinExportBufferWithStats(
  buffer: Buffer,
  filename: string,
): {
  items: ImportedVoiceItem[];
  messages: ImportedVoiceMessage[];
  stats: LinkedinExportParseStats;
} {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.zip')) {
    const { sharesCsv, commentsCsv, messagesCsv } = extractLinkedinExportZip(buffer);
    // Guarded, not unconditional: `parseLinkedinVoiceExport` throws when
    // both are null, which is exactly the shape of the "Basic" archive
    // that only carries messages.csv - that case must succeed with zero
    // posts/comments, not throw.
    const items =
      sharesCsv || commentsCsv ? parseLinkedinVoiceExport({ sharesCsv, commentsCsv }) : [];
    return {
      items,
      messages: messagesCsv ? parseMessagesCsv(messagesCsv) : [],
      stats: {
        post: sharesCsv ? parseSharesCsvStats(sharesCsv) : EMPTY_STATS,
        comment: commentsCsv ? parseCommentsCsvStats(commentsCsv) : EMPTY_STATS,
        message: messagesCsv ? parseMessagesCsvStats(messagesCsv) : EMPTY_STATS,
      },
    };
  }
  if (lower.endsWith('.csv')) {
    const text = decodeUtf8(buffer);
    const kind = detectCsvKind(text);
    if (kind === 'shares') {
      return {
        items: parseLinkedinVoiceExport({ sharesCsv: text }),
        messages: [],
        stats: { post: parseSharesCsvStats(text), comment: EMPTY_STATS, message: EMPTY_STATS },
      };
    }
    if (kind === 'comments') {
      return {
        items: parseLinkedinVoiceExport({ commentsCsv: text }),
        messages: [],
        stats: { post: EMPTY_STATS, comment: parseCommentsCsvStats(text), message: EMPTY_STATS },
      };
    }
    if (kind === 'messages') {
      return {
        items: [],
        messages: parseMessagesCsv(text),
        stats: { post: EMPTY_STATS, comment: EMPTY_STATS, message: parseMessagesCsvStats(text) },
      };
    }
    throw new Error(
      'Could not tell whether this is a Shares.csv, a Comments.csv or a messages.csv from its header row.',
    );
  }
  throw new Error(`Unsupported file "${filename}" - expected a .zip export or a .csv file.`);
}

/**
 * Reads a LinkedIn voice export from a buffer - the zip LinkedIn hands
 * back directly, or one already-extracted CSV - and parses it into
 * importable posts/comments. The CLI's `voice:import` command and the
 * companion's `/companion/voice` upload action both call this one
 * function, so the two paths cannot drift apart.
 *
 * Messages (LOR-267) are deliberately not included here - see
 * `parseLinkedinExportBufferWithStats`'s own comment on why they are a
 * separate field; a caller that wants them calls that function directly.
 */
export function parseLinkedinExportBuffer(buffer: Buffer, filename: string): ImportedVoiceItem[] {
  return parseLinkedinExportBufferWithStats(buffer, filename).items;
}
