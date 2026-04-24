import { describe, it, expect } from 'vitest';
import { matchIncomingDms, type IncomingDm, type ContactRow } from '../src/dm-sync.js';

const base: ContactRow = {
  id: 1,
  accountHandle: 'me',
  targetUser: 'alice',
  platformId: 7,
  draftId: 42,
  lastContactedAt: new Date('2026-04-24T10:00:00Z'),
  repliedAt: null,
};

function dm(partial: Partial<IncomingDm>): IncomingDm {
  return {
    fromUser: 'alice',
    toUser: 'me',
    body: 'hi',
    threadId: 't4_aaa',
    createdAt: '2026-04-24T11:00:00Z',
    ...partial,
  };
}

describe('matchIncomingDms', () => {
  it('records a reply from target → matches contact and updates repliedAt', () => {
    const { inserts, updates } = matchIncomingDms([dm({})], [base]);
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toMatchObject({
      contactId: 1,
      draftId: 42,
      author: 'alice',
      isFromUs: false,
      body: 'hi',
      platformId: 7,
    });
    expect(updates).toEqual([
      { contactId: 1, draftId: 42, repliedAt: new Date('2026-04-24T11:00:00Z') },
    ]);
  });

  it('records our outgoing DM with isFromUs=true, no update', () => {
    const ours = dm({ fromUser: 'me', toUser: 'alice', body: 'hey' });
    const { inserts, updates } = matchIncomingDms([ours], [base]);
    expect(inserts).toHaveLength(1);
    expect(inserts[0].isFromUs).toBe(true);
    expect(updates).toEqual([]);
  });

  it('ignores DMs with no matching contact', () => {
    const stranger = dm({ fromUser: 'zoe', toUser: 'me' });
    const { inserts, updates } = matchIncomingDms([stranger], [base]);
    expect(inserts).toEqual([]);
    expect(updates).toEqual([]);
  });

  it('normalises handle case and strips u/ prefix', () => {
    const r = dm({ fromUser: 'u/ALICE', toUser: 'u/ME' });
    const { inserts } = matchIncomingDms([r], [base]);
    expect(inserts).toHaveLength(1);
  });

  it('drops DMs older than lastContactedAt − 5m', () => {
    const tooOld = dm({ createdAt: '2026-04-24T09:50:00Z' });
    const { inserts, updates } = matchIncomingDms([tooOld], [base]);
    expect(inserts).toEqual([]);
    expect(updates).toEqual([]);
  });

  it('deduplicates by (platformId, platformMessageId) inside the batch', () => {
    const a = dm({ threadId: 't4_aaa' });
    const b = dm({ threadId: 't4_aaa', body: 'dup' });
    const { inserts } = matchIncomingDms([a, b], [base]);
    expect(inserts).toHaveLength(1);
  });

  it('when multiple replies from target, updates.repliedAt is the earliest', () => {
    const r1 = dm({ threadId: 't4_1', createdAt: '2026-04-24T12:00:00Z' });
    const r2 = dm({ threadId: 't4_2', createdAt: '2026-04-24T11:00:00Z' });
    const { updates } = matchIncomingDms([r1, r2], [base]);
    expect(updates).toHaveLength(1);
    expect(updates[0].repliedAt).toEqual(new Date('2026-04-24T11:00:00Z'));
  });

  it('does not emit an update when repliedAt is already set', () => {
    const already = { ...base, repliedAt: new Date('2026-04-24T10:30:00Z') };
    const { inserts, updates } = matchIncomingDms([dm({})], [already]);
    expect(inserts).toHaveLength(1);
    expect(updates).toEqual([]);
  });
});
