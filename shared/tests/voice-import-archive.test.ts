import { describe, it, expect } from 'vitest';
import AdmZip from 'adm-zip';
import {
  extractLinkedinExportZip,
  parseLinkedinExportBuffer,
} from '../src/voice-import-archive.js';

// LOR-223: the impure half of the importer - reading Shares.csv/Comments.csv
// out of a real zip archive (LinkedIn's own export shape) and off a bare
// CSV, and handing the text to the pure parser (voice-import.test.ts covers
// the parser itself in full). Builds real zip buffers with the same
// library the extractor uses, which is the correct end-to-end proof for
// this file since the archive format itself, not this library's own
// round-trip, is what a differently-shaped LinkedIn export could break.

const SHARES_CSV = [
  'Date,ShareLink,ShareCommentary',
  '2026-04-01,https://www.linkedin.com/feed/update/urn:li:activity:zip-1,Shipped the archive importer today.',
].join('\n');

const COMMENTS_CSV = [
  'Date,Link,Message',
  '2026-04-01,https://www.linkedin.com/feed/update/urn:li:activity:zip-10,Great read.',
].join('\n');

function zipOf(entries: Record<string, string>): Buffer {
  const zip = new AdmZip();
  for (const [name, content] of Object.entries(entries)) {
    zip.addFile(name, Buffer.from(content, 'utf8'));
  }
  return zip.toBuffer();
}

describe('extractLinkedinExportZip', () => {
  it('finds both files at the top level of the archive', () => {
    const buffer = zipOf({ 'Shares.csv': SHARES_CSV, 'Comments.csv': COMMENTS_CSV });
    const { sharesCsv, commentsCsv } = extractLinkedinExportZip(buffer);
    expect(sharesCsv).toBe(SHARES_CSV);
    expect(commentsCsv).toBe(COMMENTS_CSV);
  });

  it('finds both files nested under a folder, matching by filename not path', () => {
    const buffer = zipOf({
      'Basic_LinkedInDataExport_2026-04-01/Shares.csv': SHARES_CSV,
      'Basic_LinkedInDataExport_2026-04-01/Comments.csv': COMMENTS_CSV,
    });
    const { sharesCsv, commentsCsv } = extractLinkedinExportZip(buffer);
    expect(sharesCsv).toBe(SHARES_CSV);
    expect(commentsCsv).toBe(COMMENTS_CSV);
  });

  it('is fine with only one of the two files present', () => {
    const buffer = zipOf({ 'Shares.csv': SHARES_CSV });
    const { sharesCsv, commentsCsv } = extractLinkedinExportZip(buffer);
    expect(sharesCsv).toBe(SHARES_CSV);
    expect(commentsCsv).toBeNull();
  });

  it('throws a readable error when neither file is present', () => {
    const buffer = zipOf({ 'Profile.csv': 'Name\nSomeone' });
    expect(() => extractLinkedinExportZip(buffer)).toThrow(
      /neither a Shares\.csv nor a Comments\.csv/,
    );
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
