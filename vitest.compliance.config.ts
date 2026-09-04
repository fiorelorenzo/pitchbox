import { defineConfig } from 'vitest/config';

// The linkedin-compliance boundary check (#308) is pure static analysis over
// source files on disk - no Postgres, no globalSetup migrate/seed. It runs as
// its own vitest project (via `pnpm run test:linkedin-compliance`) so the CI
// `quality` job, which has no database service, can run it without paying for
// one. The full `vitest.config.ts` suite (which needs Postgres) also picks up
// this same test file through its `**/tests/**/*.test.ts` include pattern
// when `pnpm test` runs in the `test` job - that's fine, the check itself
// never touches the database either way.
export default defineConfig({
  test: {
    include: ['tests/compliance/**/*.test.ts'],
    environment: 'node',
  },
});
