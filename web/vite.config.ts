import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Optionally wire the private cloud adapter (`@pitchbox/cloud-adapter`) when it is
// present in the umbrella (the cloud edition). In an OSS clone the path is absent,
// so the alias is simply not added and the `cloud` runner stays unconfigured.
const cloudAdapter = fileURLToPath(new URL('../cloud/adapter/src/index.ts', import.meta.url));
const cloudAlias: Record<string, string> = existsSync(cloudAdapter)
  ? { '@pitchbox/cloud-adapter': cloudAdapter }
  : {};
const cloudDir = fileURLToPath(new URL('../cloud', import.meta.url));

export default defineConfig(({ command }) => {
  const isDev = command === 'serve';
  return {
    plugins: [tailwindcss(), sveltekit()],
    // Vite's dep-optimizer + SSR cache. Default is node_modules/.vite, which is not
    // writable when the app runs from a read-only image dir; allow an override.
    cacheDir: process.env.VITE_CACHE_DIR || 'node_modules/.vite',
    server: {
      // Bind localhost (IPv4) so the dev server is NOT exposed on the network/public
      // IP, while staying reachable at 127.0.0.1 (which the daemon and tooling use;
      // a bare `localhost` can resolve to ::1 and miss IPv4-only callers).
      host: '127.0.0.1',
      port: Number(process.env.WEB_PORT ?? 5180),
      strictPort: true,
      // Allow Vite to read the private adapter source outside the project root (dev).
      fs: { allow: [cloudDir] },
    },
    // In dev, Vite resolves/processes the workspace TS packages itself. In the
    // production build we do NOT bundle `@pitchbox/*`: they stay external and load
    // at runtime under `node --import tsx`, which keeps their CJS deps (ajv via the
    // MCP SDK, the reddit stealth stack) out of the ESM bundle where `require()`
    // would be undefined. The alias only matters for dev.
    resolve: { alias: isDev ? cloudAlias : {} },
    ssr: {
      external: isDev
        ? []
        : ['@pitchbox/shared', '@pitchbox/cli', '@pitchbox/daemon', '@pitchbox/cloud-adapter'],
      // Packages that ship `.svelte` source files must be bundled by Vite for SSR
      // instead of being loaded by Node as ESM.
      noExternal: ['svelte-sonner', 'bits-ui', '@lucide/svelte'],
    },
  };
});
