// The impure half of the LinkedIn export importer (LOR-223): reading a zip
// or a bare CSV off disk/upload and handing text to the pure parser in
// voice-import.ts. Kept in its own file so voice-import.ts stays pure and
// unit-testable without touching a filesystem.

import AdmZip from 'adm-zip';
import { detectCsvKind, parseLinkedinVoiceExport, type ImportedVoiceItem } from './voice-import.js';

const SHARES_ENTRY = /(?:^|\/)shares\.csv$/iu;
const COMMENTS_ENTRY = /(?:^|\/)comments\.csv$/iu;

function decodeUtf8(buffer: Buffer): string {
  let text = buffer.toString('utf8');
  // Strip a UTF-8 BOM - LinkedIn's own export writes one.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return text;
}

/** Reads `Shares.csv`/`Comments.csv` out of a LinkedIn "Get a copy of your
 * data" zip, wherever they sit inside it (some export versions nest every
 * CSV under a dated folder). Matches by filename, not by position in the
 * archive. Throws when the zip carries neither - the same "fail loudly on
 * a shape this parser does not recognise" posture voice-import.ts's column
 * resolution takes. */
export function extractLinkedinExportZip(buffer: Buffer): {
  sharesCsv: string | null;
  commentsCsv: string | null;
} {
  const zip = new AdmZip(buffer);
  let sharesCsv: string | null = null;
  let commentsCsv: string | null = null;
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;
    if (SHARES_ENTRY.test(entry.entryName)) {
      sharesCsv = decodeUtf8(entry.getData());
    } else if (COMMENTS_ENTRY.test(entry.entryName)) {
      commentsCsv = decodeUtf8(entry.getData());
    }
  }
  if (sharesCsv === null && commentsCsv === null) {
    throw new Error(
      'This archive has neither a Shares.csv nor a Comments.csv. Check this is a LinkedIn "Get a copy of your data" export.',
    );
  }
  return { sharesCsv, commentsCsv };
}

/**
 * Reads a LinkedIn voice export from a buffer - the zip LinkedIn hands
 * back directly, or one already-extracted CSV - and parses it into
 * importable voice-corpus items. The CLI's `voice:import` command and the
 * companion's `/companion/voice` upload action both call this one
 * function, so the two paths cannot drift apart.
 */
export function parseLinkedinExportBuffer(buffer: Buffer, filename: string): ImportedVoiceItem[] {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.zip')) {
    const { sharesCsv, commentsCsv } = extractLinkedinExportZip(buffer);
    return parseLinkedinVoiceExport({ sharesCsv, commentsCsv });
  }
  if (lower.endsWith('.csv')) {
    const text = decodeUtf8(buffer);
    const kind = detectCsvKind(text);
    if (kind === 'shares') return parseLinkedinVoiceExport({ sharesCsv: text });
    if (kind === 'comments') return parseLinkedinVoiceExport({ commentsCsv: text });
    throw new Error(
      'Could not tell whether this is a Shares.csv or a Comments.csv from its header row.',
    );
  }
  throw new Error(`Unsupported file "${filename}" - expected a .zip export or a .csv file.`);
}
