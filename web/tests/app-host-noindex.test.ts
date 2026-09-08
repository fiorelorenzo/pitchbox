import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Static-analysis guard for issue #426 (app half): app.pitchbox.app serves
// the logged-in Pitchbox dashboard behind a login wall a crawler can never
// get past, while the apex will carry a separate marketing landing. The app
// host should ask not to be indexed at all rather than advertise marketing
// preview metadata that made sense only while the apex served the app.

function readSource(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(`../${relativePath}`, import.meta.url)), 'utf8');
}

describe('app host asks not to be indexed (#426)', () => {
  it('robots.txt disallows crawling the whole app host', () => {
    const robots = readSource('static/robots.txt');
    const lines = robots
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'));
    expect(lines).toContain('User-agent: *');
    expect(lines).toContain('Disallow: /');
  });

  it('app.html carries a blanket noindex directive', () => {
    const appHtml = readSource('src/app.html');
    expect(appHtml).toMatch(/<meta\s+name="robots"\s+content="noindex,\s*nofollow"\s*\/>/);
  });

  it('app.html no longer advertises apex marketing OG/Twitter previews', () => {
    const appHtml = readSource('src/app.html');
    expect(appHtml).not.toMatch(/property="og:/);
    expect(appHtml).not.toMatch(/name="twitter:/);
  });

  it('the per-page Seo component no longer emits OG/Twitter preview tags', () => {
    // A logged-in app has no link previews to earn: a crawler or an
    // unfurling bot can never authenticate past the login wall to fetch the
    // page these tags describe, so they were dead weight kept only from the
    // days the apex served the app directly.
    const seo = readSource('src/lib/components/Seo.svelte');
    expect(seo).not.toMatch(/property="og:/);
    expect(seo).not.toMatch(/name="twitter:/);
  });
});
