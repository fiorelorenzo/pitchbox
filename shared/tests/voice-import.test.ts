import { describe, it, expect } from 'vitest';
import {
  parseSharesCsv,
  parseCommentsCsv,
  parseMessagesCsv,
  parseMessagesCsvStats,
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
//
// LOR-267 adds `messages.csv` (the "Basic" archive's only usable file):
// besides the same quoted-newline/empty-body/reordered-header shapes, a
// message fixture also has to prove the corpus never absorbs somebody
// else's private correspondence or an unsent draft - see
// `identifyOperatorProfileUrl`'s own comment in voice-import.ts for why
// that predicate reads `SENDER PROFILE URL` across conversations rather
// than a `FROM` display name.

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

// Two conversations, so the operator (party to both) is decisively
// distinguishable from either correspondent (party to only their own):
// conv-1 is Alex Operator <-> Pat Correspondent, conv-2 is Alex Operator
// <-> Sam Contact. Row order mixes senders on purpose - the predicate
// must not assume the operator's own rows come first or last.
const MESSAGES_CSV = [
  'CONVERSATION ID,CONVERSATION TITLE,FROM,SENDER PROFILE URL,TO,RECIPIENT PROFILE URLS,DATE,SUBJECT,CONTENT,FOLDER,ATTACHMENTS,IS MESSAGE DRAFT',
  'conv-1,,Pat Correspondent,https://www.linkedin.com/in/pat-correspondent,Alex Operator,https://www.linkedin.com/in/alex-operator,2026-01-01 09:00:00 UTC,,Hi there!,INBOX,,No',
  'conv-1,,Alex Operator,https://www.linkedin.com/in/alex-operator,Pat Correspondent,https://www.linkedin.com/in/pat-correspondent,2026-01-01 09:05:00 UTC,,"Hello!\nGreat to hear from you.",INBOX,,No',
  'conv-1,,Alex Operator,https://www.linkedin.com/in/alex-operator,Pat Correspondent,https://www.linkedin.com/in/pat-correspondent,2026-01-01 09:06:00 UTC,,,INBOX,,No',
  'conv-2,,Sam Contact,https://www.linkedin.com/in/sam-contact,Alex Operator,https://www.linkedin.com/in/alex-operator,2026-01-02 10:00:00 UTC,,Thanks for reaching out!,INBOX,,No',
  'conv-2,,Alex Operator,https://www.linkedin.com/in/alex-operator,Sam Contact,https://www.linkedin.com/in/sam-contact,2026-01-02 10:10:00 UTC,,Sounds great - lets talk this week.,INBOX,,No',
  'conv-2,,Alex Operator,https://www.linkedin.com/in/alex-operator,Sam Contact,https://www.linkedin.com/in/sam-contact,2026-01-02 10:11:00 UTC,,Draft I never sent,INBOX,,Yes',
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

describe('parseMessagesCsv', () => {
  it("imports the operator's own message, preserving a quoted embedded newline", () => {
    const items = parseMessagesCsv(MESSAGES_CSV);
    const greeting = items.find((i) => i.text.startsWith('Hello!'));
    expect(greeting?.text).toBe('Hello!\nGreat to hear from you.');
    expect(greeting?.postedAt).toBe(new Date('2026-01-01 09:05:00 UTC').toISOString());
  });

  it('skips a row with an empty body', () => {
    const items = parseMessagesCsv(MESSAGES_CSV);
    // The operator's own conv-1 row at 09:06 has no CONTENT - present in
    // the fixture, must not surface as an imported item with empty text.
    expect(items.some((i) => i.text === '')).toBe(false);
  });

  it('skips a row sent by somebody else', () => {
    const items = parseMessagesCsv(MESSAGES_CSV);
    expect(items.some((i) => i.text === 'Hi there!')).toBe(false);
    expect(items.some((i) => i.text === 'Thanks for reaching out!')).toBe(false);
  });

  it('skips a draft row, even one written by the operator', () => {
    const items = parseMessagesCsv(MESSAGES_CSV);
    expect(items.some((i) => i.text === 'Draft I never sent')).toBe(false);
  });

  it("imports only the operator's own rows: two of six", () => {
    const items = parseMessagesCsv(MESSAGES_CSV);
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.text).sort()).toEqual(
      ['Hello!\nGreat to hear from you.', 'Sounds great - lets talk this week.'].sort(),
    );
  });

  it('resolves columns by name, not position - a reordered header parses identically', () => {
    const reordered = [
      'CONTENT,SENDER PROFILE URL,CONVERSATION ID,IS MESSAGE DRAFT,DATE',
      'First message,https://www.linkedin.com/in/reordered-operator,conv-a,No,2026-03-01',
      'A reply,https://www.linkedin.com/in/reordered-other,conv-a,No,2026-03-01',
      'Second message,https://www.linkedin.com/in/reordered-operator,conv-b,No,2026-03-02',
    ].join('\n');
    const items = parseMessagesCsv(reordered);
    expect(items.map((i) => i.text).sort()).toEqual(['First message', 'Second message']);
  });

  it('derives the same external id for the same row parsed twice - a re-import is a no-op', () => {
    const first = parseMessagesCsv(MESSAGES_CSV);
    const second = parseMessagesCsv(MESSAGES_CSV);
    expect(first.map((i) => i.externalId)).toEqual(second.map((i) => i.externalId));
  });

  it('cannot attribute a single-conversation file - conservative, not guessed', () => {
    // Both parties send exactly once, in the same one conversation: a tie,
    // not a decisive winner - identifyOperatorProfileUrl must not guess
    // which side is the operator.
    const oneConversation = [
      'CONVERSATION ID,SENDER PROFILE URL,CONTENT,IS MESSAGE DRAFT',
      'conv-only,https://www.linkedin.com/in/party-one,Hello,No',
      'conv-only,https://www.linkedin.com/in/party-two,Hi back,No',
    ].join('\n');
    expect(parseMessagesCsv(oneConversation)).toHaveLength(0);
  });
});

describe('parseMessagesCsvStats', () => {
  it('accounts for every row: 2 imported, 4 skipped, 6 total', () => {
    const stats = parseMessagesCsvStats(MESSAGES_CSV);
    expect(stats).toEqual({ totalRows: 6, imported: 2, skipped: 4 });
  });
});

describe('detectCsvKind', () => {
  it('recognises Shares.csv, Comments.csv and messages.csv headers', () => {
    expect(detectCsvKind(SHARES_CSV)).toBe('shares');
    expect(detectCsvKind(COMMENTS_CSV)).toBe('comments');
    expect(detectCsvKind(MESSAGES_CSV)).toBe('messages');
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
