import { describe, expect, it } from 'vitest';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { SCENARIO_SLUGS } from '../src/campaigns/scenarios.js';
import { BUILTIN_PLAYBOOKS } from '../src/db/seed-core.js';

// Covers #351: SCENARIO_SLUGS (shared/src/campaigns/scenarios.ts),
// BUILTIN_PLAYBOOKS (shared/src/db/seed-core.ts) and the playbooks/*.md files
// on disk are three lists that have to agree. Nothing short of a test
// comparing all three would have caught #299 registering linkedin-commenter
// and linkedin-poster with no markdown behind them yet.
//
// playbooks/ also holds files that are deliberately not campaign scenarios:
// web/src/lib/server/runner.ts's dispatchRun() reads these straight off disk
// by a hardcoded slug (`resolve(PITCHBOX_ROOT, 'playbooks', \`${slug}.md\`)`)
// for project extraction, insight generation, skill generation and reply
// drafting - they never get a row in the `playbooks` table via seedCore, so
// they have no business in SCENARIO_SLUGS or BUILTIN_PLAYBOOKS either. Naming
// them here is a deliberate, reviewable decision: anything else found on disk
// that isn't a registered scenario is treated as a mistake, not silently
// ignored.
const NON_SCENARIO_PLAYBOOK_SLUGS = [
  'project-extractor',
  'project-insighter',
  'campaign-skill-generator',
  'reply-drafter',
  'draft-regenerator',
];

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

function playbookSlugsOnDisk(): string[] {
  return readdirSync(resolve(repoRoot, 'playbooks'))
    .filter((f) => f.endsWith('.md'))
    .map((f) => f.slice(0, -'.md'.length));
}

describe('playbook registry: SCENARIO_SLUGS, BUILTIN_PLAYBOOKS and playbooks/*.md agree (#351)', () => {
  it('SCENARIO_SLUGS and BUILTIN_PLAYBOOKS name exactly the same slugs', () => {
    const scenarioSlugs = [...SCENARIO_SLUGS].sort();
    const builtinSlugs = BUILTIN_PLAYBOOKS.map((pb) => pb.slug).sort();
    expect(builtinSlugs).toEqual(scenarioSlugs);
  });

  it('every registered scenario slug has a playbooks/<slug>.md file on disk', () => {
    const onDisk = new Set(playbookSlugsOnDisk());
    const missing = SCENARIO_SLUGS.filter((slug) => !onDisk.has(slug));
    expect(missing).toEqual([]);
  });

  it('every non-internal playbook file on disk is registered as a scenario', () => {
    const registered = new Set<string>(SCENARIO_SLUGS);
    const orphaned = playbookSlugsOnDisk().filter(
      (slug) => !registered.has(slug) && !NON_SCENARIO_PLAYBOOK_SLUGS.includes(slug),
    );
    expect(orphaned).toEqual([]);
  });

  it('the non-scenario allowlist itself names real files that are not also registered as scenarios', () => {
    const onDisk = new Set(playbookSlugsOnDisk());
    const registered = new Set<string>(SCENARIO_SLUGS);
    for (const slug of NON_SCENARIO_PLAYBOOK_SLUGS) {
      expect(onDisk.has(slug)).toBe(true);
      expect(registered.has(slug)).toBe(false);
    }
  });
});
