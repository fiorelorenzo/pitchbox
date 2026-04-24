import { execSync } from 'node:child_process';

/**
 * Vitest global setup — runs once before any test file.
 * Applies migrations to the test database and seeds the reddit platform row.
 *
 * The `env` set in vitest.config.ts is already in process.env here, so child
 * processes we spawn inherit DATABASE_URL=.../pitchbox_test automatically.
 */
const TEST_DATABASE_URL = 'postgres://pitchbox:pitchbox@127.0.0.1:5433/pitchbox_test';

export async function setup() {
  const env = { ...process.env, DATABASE_URL: TEST_DATABASE_URL };
  const cwd = new URL('..', import.meta.url).pathname;
  execSync('npm run --silent migrate', { stdio: 'inherit', cwd, env });
  execSync('npm run -w @pitchbox/shared --silent seed:core', {
    stdio: 'inherit',
    cwd,
    env,
  });
}

export async function teardown() {
  // Nothing to do — the test DB persists between runs so developers can
  // inspect state. It's separate from the real DB.
}
