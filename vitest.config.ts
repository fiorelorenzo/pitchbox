import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['**/tests/**/*.test.ts'],
    environment: 'node',
    // Tests hit a shared Postgres; avoid parallel file execution.
    fileParallelism: false,
  },
});
