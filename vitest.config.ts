import { fileURLToPath } from 'node:url';
import { configDefaults, defineConfig } from 'vitest/config';

// Point tests at the dedicated test DB. Allow a per-run override ONLY when it names
// an isolated `pitchbox_test[_suffix]` database (used by parallel worktree agents so
// concurrent runs don't share one DB); never honor an override to the real dev DB.
function testDatabaseUrl() {
  const def = 'postgres://pitchbox:pitchbox@127.0.0.1:5434/pitchbox_test';
  const url = process.env.DATABASE_URL;
  return url && /\/pitchbox_test(_[a-z0-9-]+)?$/.test(url) ? url : def;
}

export default defineConfig({
  // @crxjs/vite-plugin's `?script`/`?iife` import suffix (used by
  // extension/src/background.ts to resolve the built path of a dynamically
  // registered content script, e.g. linkedin-comment.ts - see #308's
  // linkedin-compliance rule 6 and syncLinkedInContentScript's doc comment)
  // is only understood by the crx() plugin wired into
  // extension/vite.config.ts for the real build. This suite runs under this
  // root config instead (no crx plugin), so without a stub, Vite falls back
  // to its default handling of an unrecognised query string: load and
  // evaluate the referenced module for real. For a content script that runs
  // top-level browser-only code (e.g. `location.href`), that throws under
  // Node - and it would run on every test that merely imports background.ts,
  // whether or not the resolved path is ever used. Stub it to an inert path
  // string instead, mirroring the shape crx's own transform returns.
  plugins: [
    {
      name: 'stub-crx-dynamic-script-imports',
      enforce: 'pre' as const,
      resolveId(source: string) {
        if (source.endsWith('?script') || source.endsWith('?iife')) return `\0${source}`;
        return null;
      },
      load(id: string) {
        if (id.startsWith('\0') && (id.endsWith('?script') || id.endsWith('?iife'))) {
          return 'export default "stub-content-script.js";';
        }
        return null;
      },
    },
  ],
  // SvelteKit's `$lib` alias so tests can import server route handlers
  // (`web/src/routes/**/+server.ts`) that resolve `$lib/server/...` at module load.
  resolve: {
    alias: {
      $lib: fileURLToPath(new URL('./web/src/lib', import.meta.url)),
    },
    // Svelte's package exports hand back its *server* build unless the
    // `browser` condition is set, and its server build throws
    // `mount(...) is not available on the server`. The extension's in-page
    // panel host (`extension/src/content/shared/panel-host.ts`) calls `mount`
    // for real in a jsdom test, so the condition has to be on. Only DOM tests
    // import `svelte` at all, and the node-environment suites (DB, CLI, server
    // routes) resolve nothing differently under it - the full suite is the
    // check that this stays true.
    conditions: ['browser'],
  },
  test: {
    include: ['**/tests/**/*.test.ts'],
    // The cloud/* submodules are separate repos with their own vitest config +
    // CI (no DB, their own timeouts). The umbrella suite must not reach into
    // them - CI never checks them out, so excluding them keeps a local run
    // (where the submodules ARE checked out) matching CI.
    exclude: [...configDefaults.exclude, 'cloud/**'],
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
