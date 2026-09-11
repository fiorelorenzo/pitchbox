import { beforeAll, afterAll } from 'vitest';

/**
 * Environment containment between test files.
 *
 * `fileParallelism` is off and vitest reuses one worker process, so all 355
 * test files share one `process.env`. Thirty of them set `PITCHBOX_EDITION`
 * (and a few set other keys) and restore it by hand, which holds only while
 * nothing throws between the assignment and the restore. When it does not
 * hold, the file that pays is some unrelated one later in the run: a
 * suggestion route answering `Agent runner "claude-code" is not available in
 * this deployment's edition` because a previous file left the deployment on
 * cloud (LOR-217). That failure names neither the leak nor the leaking file,
 * which is what makes a red `preflight` unreadable.
 *
 * This snapshots the environment when a file starts and puts it back when the
 * file ends, so a leak cannot outlive the file that caused it. Inside a file,
 * a test still sees what its own `beforeEach` set, which is what those tests
 * are for.
 */

type Env = Record<string, string | undefined>;

/**
 * Undo every difference between `process.env` and `snapshot`: keys added
 * since are removed, keys changed are put back, keys deleted are restored.
 */
export function restoreEnv(snapshot: Env, env: Env = process.env): void {
  for (const key of Object.keys(env)) {
    if (!(key in snapshot)) delete env[key];
    else if (env[key] !== snapshot[key]) env[key] = snapshot[key];
  }
  for (const [key, value] of Object.entries(snapshot)) {
    if (!(key in env) && value !== undefined) env[key] = value;
  }
}

let snapshot: Env = {};

beforeAll(() => {
  snapshot = { ...process.env };
});

afterAll(() => {
  restoreEnv(snapshot);
});
