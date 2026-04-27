import { describe, it, expect } from 'vitest';
import {
  matchIncomingCommentReplies,
  type CommentDraftRow,
  type CommentReplyContact,
  type IncomingCommentReply,
} from '../src/comment-sync.js';

const draft: CommentDraftRow = {
  draftId: 7,
  accountHandle: 'fiorelorenzo',
  platformId: 1,
  platformCommentId: 't1_us',
};

function reply(partial: Partial<IncomingCommentReply>): IncomingCommentReply {
  return {
    parentCommentId: 't1_us',
    replyCommentId: 't1_them1',
    author: 'alice',
    body: 'cool',
    createdAt: '2026-04-25T10:00:00Z',
    contextUrl: '/r/X/comments/Y/_/t1_them1/?context=3',
    ...partial,
  };
}

describe('matchIncomingCommentReplies', () => {
  it('records a single reply, creating a new contact and firing one replied event', () => {
    const r = matchIncomingCommentReplies([reply({})], [draft], []);
    expect(r.contactsToCreate).toHaveLength(1);
    expect(r.contactsToCreate[0]).toMatchObject({
      accountHandle: 'fiorelorenzo',
      targetUser: 'alice',
      draftId: 7,
      platformContextUrl: '/r/X/comments/Y/_/t1_them1/?context=3',
    });
    expect(r.messageInserts).toHaveLength(1);
    expect(r.messageInserts[0]).toMatchObject({
      author: 'alice',
      isFromUs: false,
      body: 'cool',
      platformMessageId: 't1_them1',
    });
    expect(r.draftRepliedEvents).toEqual([
      { draftId: 7, repliedAt: new Date('2026-04-25T10:00:00Z') },
    ]);
  });

  it('skips replies whose parent does not match any of our drafts', () => {
    const stranger = reply({ parentCommentId: 't1_other' });
    const r = matchIncomingCommentReplies([stranger], [draft], []);
    expect(r.contactsToCreate).toEqual([]);
    expect(r.messageInserts).toEqual([]);
    expect(r.draftRepliedEvents).toEqual([]);
  });

  it('reuses existing contact and does NOT fire a second replied event from the same user', () => {
    const existing: CommentReplyContact = {
      contactId: 99,
      accountHandle: 'fiorelorenzo',
      targetUser: 'alice',
      draftId: 7,
      repliedAt: new Date('2026-04-25T09:00:00Z'),
    };
    const r = matchIncomingCommentReplies([reply({})], [draft], [existing]);
    expect(r.contactsToCreate).toEqual([]);
    expect(r.messageInserts).toHaveLength(1);
    expect(r.messageInserts[0].contactKey).toEqual({ kind: 'existing', contactId: 99 });
    expect(r.draftRepliedEvents).toEqual([]);
  });

  it('emits one replied event per draft (earliest reply across multiple repliers)', () => {
    const r1 = reply({
      author: 'alice',
      replyCommentId: 't1_a',
      createdAt: '2026-04-25T11:00:00Z',
    });
    const r2 = reply({ author: 'bob', replyCommentId: 't1_b', createdAt: '2026-04-25T10:00:00Z' });
    const out = matchIncomingCommentReplies([r1, r2], [draft], []);
    expect(out.contactsToCreate).toHaveLength(2);
    expect(out.draftRepliedEvents).toHaveLength(1);
    expect(out.draftRepliedEvents[0]).toEqual({
      draftId: 7,
      repliedAt: new Date('2026-04-25T10:00:00Z'),
    });
  });

  it('normalises author handles (case + u/ prefix)', () => {
    const r = matchIncomingCommentReplies([reply({ author: 'u/ALICE' })], [draft], []);
    expect(r.contactsToCreate[0].targetUser).toBe('alice');
    expect(r.messageInserts[0].author).toBe('alice');
  });

  it('dedupes by (platformId, replyCommentId) within the batch', () => {
    const a = reply({ replyCommentId: 't1_dup' });
    const b = reply({ replyCommentId: 't1_dup', body: 'ignored' });
    const r = matchIncomingCommentReplies([a, b], [draft], []);
    expect(r.messageInserts).toHaveLength(1);
    expect(r.messageInserts[0].body).toBe('cool');
  });

  it('handles second message from a user whose first reply already updated repliedAt earlier in the batch', () => {
    const r1 = reply({ replyCommentId: 't1_first', createdAt: '2026-04-25T10:00:00Z' });
    const r2 = reply({ replyCommentId: 't1_second', createdAt: '2026-04-25T10:05:00Z' });
    const out = matchIncomingCommentReplies([r1, r2], [draft], []);
    expect(out.contactsToCreate).toHaveLength(1);
    expect(out.messageInserts).toHaveLength(2);
    expect(out.draftRepliedEvents).toHaveLength(1);
  });
});
