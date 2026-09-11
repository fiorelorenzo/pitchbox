// A pure, synchronous parser from LinkedIn "Get a copy of your data" CSV
// text to importable voice-corpus rows (LOR-223). No I/O, no zip handling -
// see voice-import-archive.ts for the part of this that has to touch a
// filesystem or an archive. Kept pure for the same reason
// assist/voice-profile.ts is: unit-testable against a committed synthetic
// fixture, deterministic, and reviewable without running anything.
//
// The archive carries `Shares.csv` (the operator's own posts, one row each)
// and `Comments.csv` (their comments, with the URL of the thing they
// commented on, but no id of their own and no post text). LinkedIn does not
// publish a stable schema for either file and has changed column names
// across export versions before, so nothing here trusts a column's
// position or a name remembered from one archive: every column is resolved
// by matching a normalized header against a small alias list, and a header
// row that matches none of the aliases for a column this parser actually
// needs is a thrown, readable error - never a silently empty column.

import { createHash } from 'node:crypto';

export type ImportedVoiceGenre = 'post' | 'comment';

export type ImportedVoiceItem = {
  /** Deterministic - the same row parsed twice produces the same id, which
   * is what lets the DB's `(organization_id, external_id)` unique index
   * make a re-run a no-op rather than a duplicate. */
  externalId: string;
  genre: ImportedVoiceGenre;
  text: string;
  /** The post's own URL, for a post. Null for a comment - a comment's own
   * permalink is not in the export, only the URL of what it replies to
   * (see `context`). */
  url: string | null;
  postedAt: string | null;
  /** For a comment, the post it was written under, as far as the export
   * knows it. Null for a post, and for a comment whose export row carried
   * no link. */
  context: string | null;
};

/** One row of a parsed CSV: raw string cells, in file order. */
type CsvRow = string[];

/**
 * A minimal RFC 4180 reader: quoted fields may contain commas, newlines
 * (`\n` or `\r\n`) and an escaped `""` for a literal quote. Handles bare
 * `\n`, `\r\n` and `\r` line endings outside quotes. Blank lines (including
 * a trailing one from the file's final newline) are dropped rather than
 * returned as one-empty-cell rows.
 */
function parseCsvRows(csvText: string): CsvRow[] {
  const rows: CsvRow[] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  const n = csvText.length;
  let i = 0;

  const endField = () => {
    row.push(field);
    field = '';
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };

  while (i < n) {
    const c = csvText[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (csvText[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += c;
      i += 1;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (c === ',') {
      endField();
      i += 1;
      continue;
    }
    if (c === '\r') {
      endRow();
      i += csvText[i + 1] === '\n' ? 2 : 1;
      continue;
    }
    if (c === '\n') {
      endRow();
      i += 1;
      continue;
    }
    field += c;
    i += 1;
  }
  if (field.length > 0 || row.length > 0) endRow();

  return rows.filter((r) => !(r.length === 1 && r[0] === ''));
}

function normalizeHeader(header: string): string {
  return header
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/gu, '');
}

type ColumnSpec = { role: string; aliases: readonly string[]; required: boolean };

/** Matches each `ColumnSpec`'s role to a column index by normalized header
 * name, never by position - a reordered export parses identically. Throws
 * a readable error naming the missing role and the headers actually seen
 * when a required column cannot be found, so a differently-named column in
 * a newer archive fails loudly instead of importing empty rows. */
function resolveColumns(header: CsvRow, specs: readonly ColumnSpec[]): Map<string, number> {
  const normalized = header.map(normalizeHeader);
  const resolved = new Map<string, number>();
  for (const spec of specs) {
    const idx = normalized.findIndex((h) => spec.aliases.includes(h));
    if (idx === -1) {
      if (spec.required) {
        throw new Error(
          `Could not find a "${spec.role}" column (looked for: ${spec.aliases.join(', ')}) among the headers: ${header.join(', ') || '(empty)'}`,
        );
      }
      continue;
    }
    resolved.set(spec.role, idx);
  }
  return resolved;
}

function cell(row: CsvRow, idx: number | undefined): string {
  return idx == null ? '' : (row[idx]?.trim() ?? '');
}

function normalizeDate(raw: string): string | null {
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Comments.csv carries no id of its own for a comment, and a share's own
 * link is not guaranteed stable across export versions either, so every
 * imported id is derived rather than trusted from the row: prefixed with
 * the import source and genre (so it can never collide with a page-capture
 * external id, which never carries this prefix) and hashed from the one
 * thing that is actually stable per row - the URL (the post's own for a
 * share, the commented-on post's for a comment), falling back to the
 * posted date when there is no URL - plus the text itself, so two
 * different rows sharing a URL (two comments under the same post) still
 * get distinct ids. */
function deriveExternalId(genre: ImportedVoiceGenre, url: string | null, text: string): string {
  const hash = createHash('sha256')
    .update(`${url ?? ''}\u0000${text}`)
    .digest('hex')
    .slice(0, 24);
  return `li-import-${genre}:${hash}`;
}

const SHARES_COLUMNS: readonly ColumnSpec[] = [
  { role: 'date', aliases: ['date'], required: false },
  // A share's own permalink. Real archives have named this "ShareLink"; a
  // "share"/"post"-qualified link column, not a bare "link" (Comments.csv's
  // own column means something else entirely and must not match here).
  {
    role: 'link',
    aliases: ['sharelink', 'shareurl', 'sharepermalink', 'postlink', 'permalink'],
    required: false,
  },
  // The written commentary, as opposed to a bare repost. Required: without
  // it there is nothing to tell a real post apart from a repost with no
  // commentary, which is exactly the row this parser has to skip.
  {
    role: 'text',
    aliases: ['sharecommentary', 'commentary', 'sharetext', 'shararecommentary'],
    required: true,
  },
];

const COMMENTS_COLUMNS: readonly ColumnSpec[] = [
  { role: 'date', aliases: ['date'], required: false },
  // The URL of the post the comment was left under - the only link
  // Comments.csv carries, and the comment's own stimulus, not its own id.
  { role: 'link', aliases: ['link', 'posturl', 'permalink', 'sourceurl'], required: false },
  {
    role: 'text',
    aliases: ['message', 'commenttext', 'comment', 'commentbody'],
    required: true,
  },
];

/** Counts from parsing one CSV: how many data rows it had (excluding the
 * header), how many turned into an `ImportedVoiceItem`, and how many were
 * dropped for having no text - a bare repost in Shares.csv, or a reaction
 * with no written comment in Comments.csv. `imported + skipped ===
 * totalRows` always. LOR-245's API route needs this to answer "how many
 * rows landed" honestly instead of `{ok:true}`; the CLI and the companion
 * form action only ever needed the items themselves, which is why these
 * counts are a separate, additive export rather than a change to
 * `parseSharesCsv`/`parseCommentsCsv`'s own return type. */
export type CsvParseStats = { totalRows: number; imported: number; skipped: number };

/**
 * Parses `Shares.csv` into posts. A row whose commentary cell is empty is
 * skipped rather than imported as an empty post - LinkedIn's export
 * carries a row for a bare repost (sharing someone else's post with no
 * added words) the same way it carries a real post, and a repost with
 * nothing added is not writing.
 */
function parseSharesRows(csvText: string): { items: ImportedVoiceItem[]; stats: CsvParseStats } {
  const rows = parseCsvRows(csvText);
  if (rows.length === 0) return { items: [], stats: { totalRows: 0, imported: 0, skipped: 0 } };
  const [header, ...body] = rows;
  const cols = resolveColumns(header!, SHARES_COLUMNS);

  const items: ImportedVoiceItem[] = [];
  let skipped = 0;
  for (const row of body) {
    const text = cell(row, cols.get('text'));
    if (!text) {
      skipped += 1;
      continue;
    }
    const url = cell(row, cols.get('link')) || null;
    items.push({
      externalId: deriveExternalId('post', url, text),
      genre: 'post',
      text,
      url,
      postedAt: normalizeDate(cell(row, cols.get('date'))),
      context: null,
    });
  }
  return { items, stats: { totalRows: body.length, imported: items.length, skipped } };
}

// Kept as its own export - the CLI (`cli/src/commands/voice.ts`) and the
// companion form action (`web/src/routes/companion/voice/+page.server.ts`)
// already import this exact name and only ever wanted the items, not the
// counts alongside them.
export function parseSharesCsv(csvText: string): ImportedVoiceItem[] {
  return parseSharesRows(csvText).items;
}

/** Same parse as `parseSharesCsv`, plus the row counts described on
 * `CsvParseStats`. */
export function parseSharesCsvStats(csvText: string): CsvParseStats {
  return parseSharesRows(csvText).stats;
}

/**
 * Parses `Comments.csv` into comments. A row whose message cell is empty
 * is skipped the same way an empty share is - some export rows carry a
 * reaction with no written text at all.
 */
function parseCommentsRows(csvText: string): { items: ImportedVoiceItem[]; stats: CsvParseStats } {
  const rows = parseCsvRows(csvText);
  if (rows.length === 0) return { items: [], stats: { totalRows: 0, imported: 0, skipped: 0 } };
  const [header, ...body] = rows;
  const cols = resolveColumns(header!, COMMENTS_COLUMNS);

  const items: ImportedVoiceItem[] = [];
  let skipped = 0;
  for (const row of body) {
    const text = cell(row, cols.get('text'));
    if (!text) {
      skipped += 1;
      continue;
    }
    const link = cell(row, cols.get('link')) || null;
    items.push({
      externalId: deriveExternalId('comment', link, text),
      genre: 'comment',
      text,
      url: null,
      postedAt: normalizeDate(cell(row, cols.get('date'))),
      context: link,
    });
  }
  return { items, stats: { totalRows: body.length, imported: items.length, skipped } };
}

export function parseCommentsCsv(csvText: string): ImportedVoiceItem[] {
  return parseCommentsRows(csvText).items;
}

/** Same parse as `parseCommentsCsv`, plus the row counts described on
 * `CsvParseStats`. */
export function parseCommentsCsvStats(csvText: string): CsvParseStats {
  return parseCommentsRows(csvText).stats;
}

/** Whether `csvText`'s header row matches Shares.csv's or Comments.csv's
 * required columns - for a caller that received one bare CSV file (not a
 * zip) and has to tell which schema it is before it can parse it. Null
 * when it matches neither. */
export function detectCsvKind(csvText: string): 'shares' | 'comments' | null {
  const [header] = parseCsvRows(csvText);
  if (!header) return null;
  try {
    resolveColumns(header, SHARES_COLUMNS);
    return 'shares';
  } catch {
    // fall through
  }
  try {
    resolveColumns(header, COMMENTS_COLUMNS);
    return 'comments';
  } catch {
    return null;
  }
}

export type LinkedinExportFiles = {
  sharesCsv?: string | null;
  commentsCsv?: string | null;
};

/**
 * Parses whichever of the two files an export actually supplied, in one
 * call - the single entry point the CLI command and the companion's upload
 * route both call, so the two paths cannot drift from each other.
 */
export function parseLinkedinVoiceExport(files: LinkedinExportFiles): ImportedVoiceItem[] {
  if (!files.sharesCsv && !files.commentsCsv) {
    throw new Error(
      'Found neither a Shares.csv nor a Comments.csv to import. Check this is a LinkedIn "Get a copy of your data" export.',
    );
  }
  const items: ImportedVoiceItem[] = [];
  if (files.sharesCsv) items.push(...parseSharesCsv(files.sharesCsv));
  if (files.commentsCsv) items.push(...parseCommentsCsv(files.commentsCsv));
  return items;
}
