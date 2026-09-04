import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config';

// `vite.config.ts` in this workspace also doubles as the crxjs *build*
// config for the shipped MV3 bundle, so a fix that only tests need does not
// belong there. Vitest resolves modules through its own SSR-style pipeline
// regardless of `test.environment` (jsdom vs node), so without an explicit
// `browser` condition, svelte's package `exports` map hands back the
// *server* build and `mount()` throws `lifecycle_function_unavailable`
// (mirrors the root `vitest.config.ts`'s comment on the same fix; see #339).
// A separate vitest config, merged with the real build config for its
// plugins and aliases, keeps the fix scoped to tests and leaves the
// production build provably untouched.
export default mergeConfig(
  viteConfig,
  defineConfig({
    resolve: {
      conditions: ['browser'],
    },
  }),
);
