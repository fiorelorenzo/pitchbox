import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// #514 follow-up (per Main's review of PR #562): the run-dispatch email
// gate lived in six hand-picked route handlers, so a seventh route added
// next month simply would not have it and nothing would fail - the same
// failure mode #358 had (a switch checked where it was read, not where it
// takes effect). This walks the real route tree and derives the set of
// routes that reach the run dispatch path from the source itself, rather
// than trusting a hardcoded list, so a new route wired to one of these
// dispatch functions fails this test until it calls requireVerifiedEmail.
//
// `web/src/routes/api/extension/**` is excluded on purpose, not by
// oversight: it is bearer-token/per-device authenticated, a different trust
// boundary than the session-cookie dashboard (see hooks.server.ts's
// isExemptPath and docs/permissions.md) - `POST /api/extension/dm-sync`
// fires `runReplyDrafting` from a device poll with no live session to gate,
// the same way the daemon's own internal /api/run dispatch has none.
const ROUTES_ROOT = new URL('../src/routes/api', import.meta.url).pathname;

// The runner functions that actually spawn an agent run
// (web/src/lib/server/runner.ts) - not `cancelRun`, which stops one instead
// of spending anything new.
const DISPATCH_FUNCTIONS = [
  'runCampaign',
  'runProjectExtraction',
  'runProjectInsights',
  'runDraftRegeneration',
  'runReplyDrafting',
  'runCampaignSkillGeneration',
];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      walk(full, out);
    } else if (name === '+server.ts') {
      out.push(full);
    }
  }
  return out;
}

/** True if `source` imports at least one dispatch function from runner.ts. */
function importsADispatchFunction(source: string): string[] {
  // Matches `import { a, b } from '.../lib/server/runner.js'` regardless of
  // relative vs `$lib` import style - every route above uses one or the
  // other.
  const importBlock = /import\s*\{([^}]+)\}\s*from\s*['"][^'"]*lib\/server\/runner\.js['"]/g;
  const names = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = importBlock.exec(source))) {
    for (const raw of match[1].split(',')) {
      const name = raw.trim();
      if (DISPATCH_FUNCTIONS.includes(name)) names.add(name);
    }
  }
  return [...names];
}

describe('every session-authenticated run-dispatch route calls requireVerifiedEmail (#514)', () => {
  const files = walk(ROUTES_ROOT).filter(
    (f) => !relative(ROUTES_ROOT, f).split('/').includes('extension'),
  );
  // Sanity: this must actually find routes, or the walk itself is broken
  // and every assertion below would vacuously pass.
  expect(files.length).toBeGreaterThan(20);

  const dispatchRoutes = files
    .map((f) => ({ file: f, source: readFileSync(f, 'utf8') }))
    .map(({ file, source }) => ({ file, source, calls: importsADispatchFunction(source) }))
    .filter(({ calls }) => calls.length > 0);

  // Sanity: this is exactly the set PR #562 gated (plus the one it missed,
  // projects/[id]/insights) - if this count drifts to 0, the regex above
  // broke rather than the routes disappearing.
  it('finds at least one dispatch route to check', () => {
    expect(dispatchRoutes.length).toBeGreaterThan(0);
  });

  for (const { file, source, calls } of dispatchRoutes) {
    const label = relative(ROUTES_ROOT, file);
    it(`${label} (calls ${calls.join(', ')}) calls requireVerifiedEmail before dispatching`, () => {
      expect(source).toContain('requireVerifiedEmail(');
    });
  }
});
