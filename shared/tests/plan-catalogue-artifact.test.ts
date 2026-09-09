import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { listPlans } from '../src/plans.js';

/**
 * `docs/design/DECISIONS.md` D24: the landing site (`pitchbox-landing`, a
 * separate repo, its own deploy, no database) cannot call resolveEntitlements,
 * so its pricing page reads a generated artifact instead of a hand-typed
 * second copy of the catalogue. `docs/plan-catalogue.json` is that artifact -
 * `scripts/export-plan-catalogue.ts` writes it from this module's own
 * listPlans(), never from a restated literal - and this test is what stops it
 * drifting from PLAN_CATALOGUE the moment someone edits a limit here without
 * re-running the script. `generatedAt`/`source` are provenance, not content,
 * so only `plans` is compared: re-running the exporter on an unchanged
 * catalogue must never fail this test merely because the date moved.
 */
const artifactPath = fileURLToPath(new URL('../../docs/plan-catalogue.json', import.meta.url));

describe('docs/plan-catalogue.json', () => {
  it('matches shared/src/plans.ts listPlans() - run `pnpm run plans:export` and commit the result', () => {
    const committed = JSON.parse(readFileSync(artifactPath, 'utf8')) as { plans: unknown };
    expect(committed.plans).toEqual(listPlans());
  });
});
