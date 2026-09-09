// Regenerates docs/plan-catalogue.json from shared/src/plans.ts's own
// listPlans() (#558). This is the one artifact a repo with no database can
// read: the marketing site is a separate deploy (`pitchbox-landing`, own
// repo, own build, no Postgres), so it cannot call resolveEntitlements, and
// docs/design/DECISIONS.md D24 rejected both a hand-typed second copy of the
// numbers and a live fetch of this app at landing build/request time. This
// script is the deliberate middle: it runs against a real import of the
// catalogue (never regexes the TypeScript source), and the landing repo's
// own `pnpm run plans:refresh` (`scripts/refresh-plans.mjs` there, same
// shape as its existing `tokens:refresh`) pulls the committed result from
// GitHub raw content when someone runs it on purpose.
//
// shared/tests/plan-catalogue-artifact.test.ts fails CI the moment this file
// drifts from listPlans() - run this script and commit the result whenever
// PLAN_CATALOGUE changes.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { listPlans } from '../shared/src/plans.js';

const outPath = fileURLToPath(new URL('../docs/plan-catalogue.json', import.meta.url));

const payload = {
  // Bump this if a field is ever added/removed/renamed on PlanDefinition in
  // a way a consumer needs to branch on.
  schemaVersion: 1,
  source: 'shared/src/plans.ts#listPlans',
  // Provenance only - plan-catalogue-artifact.test.ts compares `plans`
  // alone, so a re-run on an unchanged catalogue does not fail CI merely
  // because the date moved.
  generatedAt: new Date().toISOString().slice(0, 10),
  plans: listPlans(),
};

writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`);
console.log(`Wrote ${outPath}`);
