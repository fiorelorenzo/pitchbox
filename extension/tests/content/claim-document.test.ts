// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';

import { claimDocument } from '../../src/content/shared/claim-document.js';

/**
 * #438: two injection paths now reach the same LinkedIn page - the
 * registration (on document load) and `injectIntoOpenLinkedInTabs` (for tabs
 * that were already open). Both land in the same isolated world, so without
 * this guard a script would attach a second observer and a second listener
 * per composer, and the visible symptom would not be a duplicated panel (the
 * host dedupes those): it would be two model calls billed for one click.
 */
describe('one run per document', () => {
  it('lets exactly the first caller through, per id', () => {
    expect(claimDocument('example-script')).toBe(true);
    expect(claimDocument('example-script')).toBe(false);
    expect(claimDocument('example-script')).toBe(false);
  });

  it('keeps two different scripts independent', () => {
    expect(claimDocument('script-a')).toBe(true);
    expect(claimDocument('script-b')).toBe(true);
    expect(claimDocument('script-a')).toBe(false);
  });

  it('claims on the realm, so a page-level global cannot fake it out', () => {
    // The page cannot see the isolated world's globals, but a test can:
    // the flag has to be what decides, not a re-derivation from the DOM.
    const realm = globalThis as unknown as Record<string, unknown>;
    expect(claimDocument('script-c')).toBe(true);
    expect(realm['__pitchbox_claimed_script-c']).toBe(true);
    Reflect.deleteProperty(realm, '__pitchbox_claimed_script-c');
    expect(claimDocument('script-c')).toBe(true);
  });
});
