import { describe, expect, it } from 'vitest';
import { load as settingsIndexLoad } from '../src/routes/settings/+page.server.js';
import { load as settingsStatusLoad } from '../src/routes/settings/status/+page.server.js';
import { load as settingsLanguageLoad } from '../src/routes/settings/language/+page.server.js';
import { load as settingsCompanionLoad } from '../src/routes/settings/companion/+page.server.js';

const settingsIndexLoadFn = settingsIndexLoad as () => Promise<unknown>;
const settingsStatusLoadFn = settingsStatusLoad as () => Promise<unknown>;
const settingsLanguageLoadFn = settingsLanguageLoad as () => Promise<unknown>;
const settingsCompanionLoadFn = settingsCompanionLoad as () => Promise<unknown>;

/**
 * #186: the settings landing page was called Status - wrong ever since #254
 * flattened the tabbed General page into a rail, since Status was only ever
 * one card on it. Renamed the route to `settings/general` and the rail
 * label to General, but `/settings/status` is deep-linked (AGENTS.md), so it
 * stays as a redirect rather than 404ing. Both `/settings` (the bare landing
 * redirect) and `/settings/status` (the old route name) must still resolve
 * to the same page, `settings/general`.
 *
 * 2026-09-12 UI/UX defects batch: `settings/language`'s own picker folded
 * into a card on `settings/general` (LOR-262). Same reasoning again -
 * the route is deep-linked, so it stays a redirect rather than 404ing,
 * regardless of whether the caller is signed in.
 *
 * LOR-178/LOR-179 (docs/design/DECISIONS.md D35): `settings/companion`
 * moved to its own top-level route, `/companion`, split into three pages.
 * Same reasoning, same pattern - it stays a redirect rather than 404ing.
 */

/** A thrown SvelteKit redirect, narrowed enough to assert on. */
function redirectOf(err: unknown): { status: number; location: string } {
  const r = err as { status?: number; location?: string };
  if (typeof r?.status !== 'number' || typeof r?.location !== 'string') {
    throw new Error(`expected a redirect, got ${JSON.stringify(err)}`);
  }
  return { status: r.status, location: r.location };
}

describe('settings/+page.server.ts load: bare /settings lands on General', () => {
  it('307s to /settings/general', async () => {
    const err = await settingsIndexLoadFn().catch((e) => e);
    const redirect = redirectOf(err);
    expect(redirect.status).toBe(307);
    expect(redirect.location).toBe('/settings/general');
  });
});

describe('settings/status/+page.server.ts load: the old route name still redirects', () => {
  it('307s to /settings/general', async () => {
    const err = await settingsStatusLoadFn().catch((e) => e);
    const redirect = redirectOf(err);
    expect(redirect.status).toBe(307);
    expect(redirect.location).toBe('/settings/general');
  });
});

describe('settings/language/+page.server.ts load: the folded-in picker route still redirects', () => {
  it('307s to /settings/general', async () => {
    const err = await settingsLanguageLoadFn().catch((e) => e);
    const redirect = redirectOf(err);
    expect(redirect.status).toBe(307);
    expect(redirect.location).toBe('/settings/general');
  });
});

describe('settings/companion/+page.server.ts load: the retired settings route still redirects', () => {
  it('307s to /companion', async () => {
    const err = await settingsCompanionLoadFn().catch((e) => e);
    const redirect = redirectOf(err);
    expect(redirect.status).toBe(307);
    expect(redirect.location).toBe('/companion');
  });
});
