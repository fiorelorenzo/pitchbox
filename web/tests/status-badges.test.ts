import { describe, it, expect } from 'vitest';
import { DRAFT_KINDS } from '@pitchbox/shared/quota-types';
import { REPLY_KINDS } from '@pitchbox/shared/reply-drafter';
import { DRAFT_KIND, resolveBadge, BADGE_DOMAIN } from '../src/lib/config/status-badges';

// `resolveBadge` falls through to `{ label: value, tone: 'muted' }` for a value
// it does not know, which is the right behaviour for genuinely unknown data but
// prints the raw enum when a real kind is simply missing from the registry.
// That is how `reply_dm` and `reply_comment` came to render as literal
// `reply_dm` on the thread detail page (#258). The registry has to stay in step
// with both halves of the kind set, so assert it rather than comment it.
describe('draft kind badge registry', () => {
  const everyKind = [...DRAFT_KINDS, ...REPLY_KINDS];

  it('covers every draft kind the app can persist', () => {
    const missing = everyKind.filter((k) => !(k in DRAFT_KIND));
    expect(missing).toEqual([]);
  });

  it('never renders a raw enum value as a label', () => {
    for (const kind of everyKind) {
      const badge = resolveBadge('draft-kind', kind);
      expect(badge.label).not.toBe(kind);
      expect(badge.label).not.toMatch(/_/);
    }
  });

  it('keeps the reply kinds visually in the family they belong to', () => {
    // A reply DM is still a DM, a comment reply is still a comment reply:
    // sharing the tone is what makes the inbox scannable by shape.
    expect(resolveBadge('draft-kind', 'reply_dm').tone).toBe(resolveBadge('draft-kind', 'dm').tone);
    expect(resolveBadge('draft-kind', 'reply_comment').tone).toBe(
      resolveBadge('draft-kind', 'comment_reply').tone,
    );
  });

  it('still degrades gracefully for a value it has never seen', () => {
    const badge = resolveBadge('draft-kind', 'carrier_pigeon');
    expect(badge.label).toBe('carrier_pigeon');
    expect(badge.tone).toBe('muted');
  });

  it('exposes draft-kind through the domain registry the components use', () => {
    expect(BADGE_DOMAIN['draft-kind']).toBe(DRAFT_KIND);
  });
});
