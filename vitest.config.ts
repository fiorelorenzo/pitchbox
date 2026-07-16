import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Point tests at the dedicated test DB. Allow a per-run override ONLY when it names
// an isolated `pitchbox_test[_suffix]` database (used by parallel worktree agents so
// concurrent runs don't share one DB); never honor an override to the real dev DB.
function testDatabaseUrl() {
  const def = 'postgres://pitchbox:pitchbox@127.0.0.1:5434/pitchbox_test';
  const url = process.env.DATABASE_URL;
  return url && /\/pitchbox_test(_[a-z0-9-]+)?$/.test(url) ? url : def;
}

export default defineConfig({
  // SvelteKit's `$lib` alias so tests can import server route handlers
  // (`web/src/routes/**/+server.ts`) that resolve `$lib/server/...` at module load.
  resolve: {
    alias: {
      $lib: fileURLToPath(new URL('./web/src/lib', import.meta.url)),
    },
  },
  test: {
    include: ['**/tests/**/*.test.ts'],
    environment: 'node',
    // Tests hit a shared Postgres; avoid parallel file execution.
    fileParallelism: false,
    // CLI e2e tests shell out to `pnpm -F @pitchbox/cli dev`, which cold-starts
    // tsx (~2.5s) per call; chained start→finish runs exceed the 5s default
    // under CPU load. Give them headroom.
    testTimeout: 30000,
    globalSetup: ['./tests/global-setup.ts'],
    // Point all tests at a dedicated test database so they never truncate the
    // user's real data.
    env: {
      DATABASE_URL: testDatabaseUrl(),
      PITCHBOX_TEST_MODE: '1',
    },
  },
});
