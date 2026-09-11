import { describe, expect, it } from 'vitest';
import { adminLinks } from '../src/routes/settings/admin/admin-links.js';

// #185: `/settings/admin/models` was a real, gated page that nothing linked
// to - the admin index's first entry, "Agent runners", pointed at the
// tenant page `settings/runners` instead, which reads as "the place models
// are set" until opened and found to show one runner and no per-function
// config. `adminLinks(locale)` (web/src/routes/settings/admin/admin-links.ts)
// is what `+page.svelte` renders as the link grid, pulled into its own
// module so this is importable without rendering the component - same shape
// as instance-audit-admin-page.test.ts importing `load` directly rather than
// rendering the page it backs. LOR-263 turned the static array into a
// function of locale, so every case below fixes the locale to 'en'.

describe('settings/admin link grid (admin-links.ts)', () => {
  it('links Model configuration at /settings/admin/models', () => {
    const link = adminLinks('en').find((l) => l.href === '/settings/admin/models');
    expect(link).toBeDefined();
    expect(link?.description.toLowerCase()).toContain('model');
  });

  it('links Plan grants at /settings/admin/plan-grants (#187)', () => {
    const link = adminLinks('en').find((l) => l.href === '/settings/admin/plan-grants');
    expect(link).toBeDefined();
    expect(link?.description.toLowerCase()).toContain('plan');
  });

  it('the Agent runners entry points away from itself for model configuration', () => {
    const link = adminLinks('en').find((l) => l.href === '/settings/runners');
    expect(link).toBeDefined();
    // The bug (#185) was following this entry expecting model configuration
    // and finding one runner, no per-function config, and nothing telling
    // you where to look instead - the reworded copy now names the actual
    // page rather than staying silent about it.
    expect(link?.description.toLowerCase()).toContain('model configuration');
  });

  it('every link has a unique href', () => {
    const hrefs = adminLinks('en').map((l) => l.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });
});
