import { execSync } from 'node:child_process';

/**
 * Vitest global setup - runs once before any test file.
 * Applies migrations to the test database and seeds the reddit platform row.
 *
 * The `env` set in vitest.config.ts is already in process.env here, so child
 * processes we spawn inherit DATABASE_URL=.../pitchbox_test automatically.
 */
// Mirror vitest.config.ts: honor a per-run override only for an isolated
// pitchbox_test[_suffix] database (parallel worktree agents), else the default.
const TEST_DATABASE_URL = (() => {
  const url = process.env.DATABASE_URL;
  return url && /\/pitchbox_test(_[a-z0-9-]+)?$/.test(url)
    ? url
    : 'postgres://pitchbox:pitchbox@127.0.0.1:5434/pitchbox_test';
})();

export async function setup() {
  const env = { ...process.env, DATABASE_URL: TEST_DATABASE_URL };
  const cwd = new URL('..', import.meta.url).pathname;
  execSync('pnpm run --silent migrate', { stdio: 'inherit', cwd, env });
  execSync('pnpm -F @pitchbox/shared --silent seed:core', {
    stdio: 'inherit',
    cwd,
    env,
  });
}

export async function teardown() {
  // Nothing to do - the test DB persists between runs so developers can
  // inspect state. It's separate from the real DB.
}
