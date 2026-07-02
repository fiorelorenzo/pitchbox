import { defineConfig } from 'vitest/config';
export default defineConfig({
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
      DATABASE_URL: 'postgres://pitchbox:pitchbox@127.0.0.1:5434/pitchbox_test',
      PITCHBOX_TEST_MODE: '1',
    },
  },
});
