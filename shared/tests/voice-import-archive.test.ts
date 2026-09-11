import { describe, it, expect } from 'vitest';
import AdmZip from 'adm-zip';
import {
  extractLinkedinExportZip,
  parseLinkedinExportBuffer,
  parseLinkedinExportBufferWithStats,
} from '../src/voice-import-archive.js';

// LOR-223: the impure half of the importer - reading Shares.csv/Comments.csv
// out of a real zip archive (LinkedIn's own export shape) and off a bare
// CSV, and handing the text to the pure parser (voice-import.test.ts covers
// the parser itself in full). Builds real zip buffers with the same
// library the extractor uses, which is the correct end-to-end proof for
// this file since the archive format itself, not this library's own
// round-trip, is what a differently-shaped LinkedIn export could break.
//
// LOR-267 adds `messages.csv` - the only file LinkedIn's "Basic" archive
// carries. The acceptance this file proves for it: that archive must
// succeed (not throw), `parseLinkedinExportBuffer` (companion's own,
// frozen call) must keep returning zero items rather than messages mixed
// into a shape it never expected, and an archive with none of the three
// recognised files must still fail, naming what it actually contained.

const SHARES_CSV = [
  'Date,ShareLink,ShareCommentary',
  '2026-04-01,https://www.linkedin.com/feed/update/urn:li:activity:zip-1,Shipped the archive importer today.',
].join('\n');

const COMMENTS_CSV = [
  'Date,Link,Message',
  '2026-04-01,https://www.linkedin.com/feed/update/urn:li:activity:zip-10,Great read.',
].join('\n');

// Two conversations so the operator is decisively identifiable - see
// voice-import.test.ts's own fixture comment for why one isn't enough.
const MESSAGES_CSV = [
  'CONVERSATION ID,SENDER PROFILE URL,CONTENT,IS MESSAGE DRAFT',
  'zip-conv-1,https://www.linkedin.com/in/zip-operator,Hello from the archive test,No',
  'zip-conv-1,https://www.linkedin.com/in/zip-other,Hi back,No',
  'zip-conv-2,https://www.linkedin.com/in/zip-operator,Second conversation reply,No',
].join('\n');

function zipOf(entries: Record<string, string>): Buffer {
  const zip = new AdmZip();
  for (const [name, content] of Object.entries(entries)) {
    zip.addFile(name, Buffer.from(content, 'utf8'));
  }
  return zip.toBuffer();
}

describe('extractLinkedinExportZip', () => {
  it('finds all three files at the top level of the archive', () => {
    const buffer = zipOf({
      'Shares.csv': SHARES_CSV,
      'Comments.csv': COMMENTS_CSV,
      'messages.csv': MESSAGES_CSV,
    });
    const { sharesCsv, commentsCsv, messagesCsv } = extractLinkedinExportZip(buffer);
    expect(sharesCsv).toBe(SHARES_CSV);
    expect(commentsCsv).toBe(COMMENTS_CSV);
    expect(messagesCsv).toBe(MESSAGES_CSV);
  });

  it('finds all three files nested under a folder, matching by filename not path', () => {
    const buffer = zipOf({
      'Basic_LinkedInDataExport_2026-04-01/Shares.csv': SHARES_CSV,
      'Basic_LinkedInDataExport_2026-04-01/Comments.csv': COMMENTS_CSV,
      'Basic_LinkedInDataExport_2026-04-01/messages.csv': MESSAGES_CSV,
    });
    const { sharesCsv, commentsCsv, messagesCsv } = extractLinkedinExportZip(buffer);
    expect(sharesCsv).toBe(SHARES_CSV);
    expect(commentsCsv).toBe(COMMENTS_CSV);
    expect(messagesCsv).toBe(MESSAGES_CSV);
  });

  it('is fine with only one of the three files present', () => {
    const buffer = zipOf({ 'Shares.csv': SHARES_CSV });
    const { sharesCsv, commentsCsv, messagesCsv } = extractLinkedinExportZip(buffer);
    expect(sharesCsv).toBe(SHARES_CSV);
    expect(commentsCsv).toBeNull();
    expect(messagesCsv).toBeNull();
  });

  it('does not throw on the "Basic" archive shape - messages.csv alone, no Shares/Comments', () => {
    const buffer = zipOf({ 'messages.csv': MESSAGES_CSV });
    const { sharesCsv, commentsCsv, messagesCsv } = extractLinkedinExportZip(buffer);
    expect(sharesCsv).toBeNull();
    expect(commentsCsv).toBeNull();
    expect(messagesCsv).toBe(MESSAGES_CSV);
  });

  it('throws a readable error naming what it found when none of the three are present', () => {
    const buffer = zipOf({ 'Profile.csv': 'Name\nSomeone', 'Positions.csv': 'Title\nEngineer' });
    expect(() => extractLinkedinExportZip(buffer)).toThrow(
      /none of Shares\.csv, Comments\.csv or messages\.csv/,
    );
    expect(() => extractLinkedinExportZip(buffer)).toThrow(/Profile\.csv/);
    expect(() => extractLinkedinExportZip(buffer)).toThrow(/Positions\.csv/);
  });

  it('still mentions both Shares.csv and Comments.csv by name in that message', () => {
    // Companion's own importVoice action (web/src/routes/companion/voice)
    // rewords this exact refusal when it sees both substrings, to point a
    // customer at the "Basic" archive's own reason for existing - that
    // detection must keep working for the one case still worth rewording.
    const buffer = zipOf({ 'Profile.csv': 'Name\nSomeone' });
    try {
      extractLinkedinExportZip(buffer);
      throw new Error('expected extractLinkedinExportZip to throw');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).toContain('Shares.csv');
      expect(message).toContain('Comments.csv');
    }
  });
});

describe('parseLinkedinExportBufferWithStats', () => {
  it('imports the "Basic" archive - messages only - with zero posts/comments, not a throw', () => {
    const buffer = zipOf({ 'messages.csv': MESSAGES_CSV });
    const { items, messages, stats } = parseLinkedinExportBufferWithStats(buffer, 'export.zip');
    expect(items).toHaveLength(0);
    expect(messages.map((m) => m.text).sort()).toEqual([
      'Hello from the archive test',
      'Second conversation reply',
    ]);
    expect(stats.post).toEqual({ totalRows: 0, imported: 0, skipped: 0 });
    expect(stats.comment).toEqual({ totalRows: 0, imported: 0, skipped: 0 });
    expect(stats.message).toEqual({ totalRows: 3, imported: 2, skipped: 1 });
  });

  it('parses a full zip into items, messages and stats together', () => {
    const buffer = zipOf({
      'Shares.csv': SHARES_CSV,
      'Comments.csv': COMMENTS_CSV,
      'messages.csv': MESSAGES_CSV,
    });
    const { items, messages } = parseLinkedinExportBufferWithStats(buffer, 'export.zip');
    expect(items.filter((i) => i.genre === 'post')).toHaveLength(1);
    expect(items.filter((i) => i.genre === 'comment')).toHaveLength(1);
    expect(messages).toHaveLength(2);
  });

  it('recognises a bare messages.csv upload by its header', () => {
    const { items, messages, stats } = parseLinkedinExportBufferWithStats(
      Buffer.from(MESSAGES_CSV, 'utf8'),
      'messages.csv',
    );
    expect(items).toHaveLength(0);
    expect(messages).toHaveLength(2);
    expect(stats.message.imported).toBe(2);
  });
});

describe('parseLinkedinExportBuffer', () => {
  it('parses a zip end to end into both genres', () => {
    const buffer = zipOf({ 'Shares.csv': SHARES_CSV, 'Comments.csv': COMMENTS_CSV });
    const items = parseLinkedinExportBuffer(buffer, 'export.zip');
    expect(items.filter((i) => i.genre === 'post')).toHaveLength(1);
    expect(items.filter((i) => i.genre === 'comment')).toHaveLength(1);
  });

  it('parses a bare Shares.csv, sniffing its kind from the header', () => {
    const items = parseLinkedinExportBuffer(Buffer.from(SHARES_CSV, 'utf8'), 'Shares.csv');
    expect(items).toHaveLength(1);
    expect(items[0].genre).toBe('post');
  });

  it('parses a bare Comments.csv the same way', () => {
    const items = parseLinkedinExportBuffer(Buffer.from(COMMENTS_CSV, 'utf8'), 'Comments.csv');
    expect(items).toHaveLength(1);
    expect(items[0].genre).toBe('comment');
  });

  it('returns zero items (never throws) for a "Basic" archive - the companion page still uploads through this exact function', () => {
    const buffer = zipOf({ 'messages.csv': MESSAGES_CSV });
    expect(parseLinkedinExportBuffer(buffer, 'export.zip')).toEqual([]);
  });

  it('rejects a file extension it does not recognise', () => {
    expect(() => parseLinkedinExportBuffer(Buffer.from('hello'), 'export.txt')).toThrow(
      /Unsupported file/,
    );
  });

  it('rejects a CSV whose header matches neither known shape', () => {
    expect(() => parseLinkedinExportBuffer(Buffer.from('Foo,Bar\n1,2'), 'mystery.csv')).toThrow(
      /Could not tell whether/,
    );
  });
});
