import { describe, expect, it } from 'vitest';

// LOR-252: extension/tests/content/fixtures/linkedin/ commits real, anonymised
// captures in a public repo. Anonymisation covers names and handles - every
// /in/<slug> becomes example-person - but the capture script's own scrubbing
// missed links until LOR-228 fixed the capture path (a short comment that was
// itself a link survived, since the short-text branch let anything under 24
// characters through unscrubbed). The fixtures already committed were never
// re-scrubbed until this issue found ten real lnkd.in shortlinks, a real
// x.com handle and a real pitchbox.app URL sitting in them.
//
// This is the check LOR-252 asked for on the data itself, not only on the
// script that produced it: a fixture is data, and a hand edit or a future
// recapture can reintroduce a real link without ever touching
// capture-linkedin-fixtures.mjs. Read via Vite's raw glob import, same as
// linkedin-dom.test.ts's fixture imports and activity-i18n-coverage.test.ts's
// source scan, so this generalises to a fixture file added later without
// needing its own import line.
const fixtureFiles = import.meta.glob('./fixtures/linkedin/*.html', {
  eager: true,
  query: '?raw',
  import: 'default',
}) as Record<string, string>;

// The only host an anonymised fixture may carry: RFC 2606's example.com is
// reserved and guaranteed to never resolve to a real destination. Not "any
// host that isn't linkedin.com" - an x.com handle or a company domain like
// pitchbox.app is just as identifying as a real LinkedIn URL (see the
// fixture README's audit step), so the allowed set is synthetic hosts only.
const ALLOWED_HOSTS: Record<string, true> = { 'example.com': true };
const URL_PATTERN = /https?:\/\/[^\s"'<>]+/g;

describe('LinkedIn fixtures carry no real external link (LOR-252)', () => {
  it('scans a realistic number of fixture files', () => {
    // Guards the scanner itself: an empty glob match would make every
    // per-file assertion below pass vacuously.
    expect(Object.keys(fixtureFiles).length).toBeGreaterThanOrEqual(5);
  });

  for (const [path, html] of Object.entries(fixtureFiles)) {
    const name = path.split('/').pop();
    it(`${name} links only to a synthetic host`, () => {
      const offenders = [...html.matchAll(URL_PATTERN)]
        .map((m) => m[0])
        .filter((url) => !ALLOWED_HOSTS[url.replace(/^https?:\/\//, '').split(/[/?#]/)[0]]);
      expect(offenders, `${name} contains a real external URL: ${offenders.join(', ')}`).toEqual(
        [],
      );
    });
  }
});
