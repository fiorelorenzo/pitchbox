import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['**/tests/**/*.test.ts'],
    environment: 'node',
    // Tests hit a shared Postgres; avoid parallel file execution.
    fileParallelism: false,
    globalSetup: ['./tests/global-setup.ts'],
    // Point all tests at a dedicated test database so they never truncate the
    // user's real data.
    env: {
      DATABASE_URL: 'postgres://pitchbox:pitchbox@127.0.0.1:5433/pitchbox_test',
      PITCHBOX_TEST_MODE: '1',
    },
  },
});
