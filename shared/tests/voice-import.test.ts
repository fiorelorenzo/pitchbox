import { describe, it, expect } from 'vitest';
import {
  parseSharesCsv,
  parseCommentsCsv,
  parseLinkedinVoiceExport,
  detectCsvKind,
} from '../src/voice-import.js';

// LOR-223: the pure LinkedIn-export parser. Every case here is a shape the
// real export can carry that a naive split(',')/split('\n') would get
// wrong: a quoted field spanning multiple lines, a row with nothing
// written in it, a repost that is not writing, and a header whose columns
// arrived in a different order than expected - all four are the acceptance
// list for this file. Fixtures are entirely invented (no real LinkedIn
// content).

const SHARES_CSV = [
  'Date,ShareLink,ShareCommentary',
  '2026-01-05,https://www.linkedin.com/feed/update/urn:li:activity:1,"Shipped a new caching layer today.\nCut p99 latency in half."',
  '2026-01-06,https://www.linkedin.com/feed/update/urn:li:activity:2,',
  '2026-01-07,https://www.linkedin.com/feed/update/urn:li:activity:3,"Comma, quote ""test"", and more"',
].join('\r\n');

const COMMENTS_CSV = [
  'Date,Link,Message',
  '2026-01-05,https://www.linkedin.com/feed/update/urn:li:activity:10,Nice work on this!',
  '2026-01-06,https://www.linkedin.com/feed/update/urn:li:activity:11,',
].join('\n');

describe('parseSharesCsv', () => {
  it('parses a real post, preserving a quoted embedded newline', () => {
    const items = parseSharesCsv(SHARES_CSV);
    const first = items.find((i) => i.url?.endsWith('activity:1'));
    expect(first?.text).toBe('Shipped a new caching layer today.\nCut p99 latency in half.');
    expect(first?.genre).toBe('post');
    expect(first?.postedAt).toBe(new Date('2026-01-05').toISOString());
    expect(first?.context).toBeNull();
  });

  it('unescapes a doubled quote and keeps a literal comma inside a quoted field', () => {
    const items = parseSharesCsv(SHARES_CSV);
    const third = items.find((i) => i.url?.endsWith('activity:3'));
    expect(third?.text).toBe('Comma, quote "test", and more');
  });

  it('skips a repost with no commentary rather than importing an empty post', () => {
    const items = parseSharesCsv(SHARES_CSV);
    expect(items.some((i) => i.url?.endsWith('activity:2'))).toBe(false);
    expect(items).toHaveLength(2);
  });

  it('resolves columns by name, not position - a reordered header parses identically', () => {
    const reordered = [
      'ShareCommentary,ShareLink,Date',
      '"Reordered but still readable",https://www.linkedin.com/feed/update/urn:li:activity:99,2026-02-01',
    ].join('\n');
    const items = parseSharesCsv(reordered);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      text: 'Reordered but still readable',
      url: 'https://www.linkedin.com/feed/update/urn:li:activity:99',
      genre: 'post',
    });
  });

  it('throws a readable error naming the missing column when the header matches nothing known', () => {
    const unrecognized = ['Timestamp,Body', '2026-01-01,hello'].join('\n');
    expect(() => parseSharesCsv(unrecognized)).toThrow(/text/i);
  });

  it('derives the same external id for the same row parsed twice - a re-import is a no-op', () => {
    const first = parseSharesCsv(SHARES_CSV);
    const second = parseSharesCsv(SHARES_CSV);
    expect(first.map((i) => i.externalId)).toEqual(second.map((i) => i.externalId));
  });

  it('gives two different rows two different external ids', () => {
    const items = parseSharesCsv(SHARES_CSV);
    const ids = new Set(items.map((i) => i.externalId));
    expect(ids.size).toBe(items.length);
  });
});

describe('parseCommentsCsv', () => {
  it('parses a comment, carrying the commented-on post as context rather than url', () => {
    const items = parseCommentsCsv(COMMENTS_CSV);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      genre: 'comment',
      text: 'Nice work on this!',
      url: null,
      context: 'https://www.linkedin.com/feed/update/urn:li:activity:10',
    });
  });

  it('skips a row with an empty message cell', () => {
    const items = parseCommentsCsv(COMMENTS_CSV);
    expect(items.some((i) => i.context?.endsWith('activity:11'))).toBe(false);
  });

  it('derives distinct ids for two different comments left under the same post', () => {
    const csv = [
      'Date,Link,Message',
      '2026-01-01,https://www.linkedin.com/feed/update/urn:li:activity:same,First comment',
      '2026-01-01,https://www.linkedin.com/feed/update/urn:li:activity:same,Second comment',
    ].join('\n');
    const items = parseCommentsCsv(csv);
    expect(items).toHaveLength(2);
    expect(items[0].externalId).not.toBe(items[1].externalId);
  });
});

describe('detectCsvKind', () => {
  it('recognises Shares.csv and Comments.csv headers', () => {
    expect(detectCsvKind(SHARES_CSV)).toBe('shares');
    expect(detectCsvKind(COMMENTS_CSV)).toBe('comments');
  });

  it('returns null for a header matching neither known shape', () => {
    expect(detectCsvKind('Foo,Bar\n1,2')).toBeNull();
  });
});

describe('parseLinkedinVoiceExport', () => {
  it('combines both files when both are present', () => {
    const items = parseLinkedinVoiceExport({ sharesCsv: SHARES_CSV, commentsCsv: COMMENTS_CSV });
    expect(items.filter((i) => i.genre === 'post')).toHaveLength(2);
    expect(items.filter((i) => i.genre === 'comment')).toHaveLength(1);
  });

  it('throws when neither file is present', () => {
    expect(() => parseLinkedinVoiceExport({})).toThrow();
  });
});
