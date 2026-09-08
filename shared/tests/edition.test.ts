import { describe, expect, it, afterEach } from 'vitest';
import { AGENT_RUNNER_META } from '../src/agents/meta.js';
import { allowedRunnerSlugs, isRunnerAllowed } from '../src/edition.js';

// #410: the cloud edition must never allow a local ACP backend to be picked
// or dispatched. `allowedRunnerSlugs`/`isRunnerAllowed` are the one place
// every picker and every write route asks; a bug here reopens the leak
// everywhere at once.
describe('allowedRunnerSlugs / isRunnerAllowed (#410)', () => {
  const saved = process.env.PITCHBOX_EDITION;
  afterEach(() => {
    if (saved === undefined) delete process.env.PITCHBOX_EDITION;
    else process.env.PITCHBOX_EDITION = saved;
  });

  it('the cloud edition allows only the cloud runner', () => {
    process.env.PITCHBOX_EDITION = 'cloud';
    expect(allowedRunnerSlugs()).toEqual(['cloud']);
    expect(isRunnerAllowed('cloud')).toBe(true);
    for (const m of AGENT_RUNNER_META) {
      if (m.slug === 'cloud') continue;
      expect(isRunnerAllowed(m.slug)).toBe(false);
    }
  });

  it('self-hosted allows every catalogued runner', () => {
    delete process.env.PITCHBOX_EDITION;
    const allowed = allowedRunnerSlugs();
    for (const m of AGENT_RUNNER_META) {
      expect(allowed).toContain(m.slug);
      expect(isRunnerAllowed(m.slug)).toBe(true);
    }
  });

  it('cloud rejects an unregistered slug too; self-hosted never validated the string at all', () => {
    // Self-hosted's routes have always accepted any non-empty runner string
    // and deferred to `createAgentRunner` throwing "Unknown agent runner" -
    // this guard only draws the cloud boundary, it does not newly validate
    // self-hosted against the catalogue (that would break the deliberately
    // fake `NO_OP_RUNNER` fixture several campaign-creation tests rely on).
    delete process.env.PITCHBOX_EDITION;
    expect(isRunnerAllowed('not-a-real-runner')).toBe(true);
    process.env.PITCHBOX_EDITION = 'cloud';
    expect(isRunnerAllowed('not-a-real-runner')).toBe(false);
  });
});
