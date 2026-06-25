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

export default defineConfig({
  plugins: [tailwindcss(), sveltekit()],
  server: {
    port: Number(process.env.WEB_PORT ?? 5180),
    strictPort: true,
    // Allow Vite to read the private adapter source outside the project root.
    fs: { allow: [cloudDir] },
  },
  resolve: { alias: cloudAlias },
  ssr: {
    // Packages that ship `.svelte` source files must be bundled by Vite for SSR
    // instead of being loaded by Node as ESM.
    noExternal: ['svelte-sonner', 'bits-ui', 'lucide-svelte'],
  },
});
