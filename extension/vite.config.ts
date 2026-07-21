import path from 'node:path';
import { defineConfig } from 'vite';
import { crx } from '@crxjs/vite-plugin';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';
import manifest from './manifest.config';
import pkg from './package.json' with { type: 'json' };

export default defineConfig({
  plugins: [svelte(), tailwindcss(), crx({ manifest })],
  define: {
    'import.meta.env.VITE_APP_VERSION': JSON.stringify(pkg.version),
    // The backend the extension defaults to on a fresh install. Overridable at
    // build time for a self-hosted or preview build; the user can also add
    // other backends at runtime from the side panel. See docs/extension-connection-design.md.
    'import.meta.env.VITE_DEFAULT_BACKEND_URL': JSON.stringify(
      process.env.VITE_DEFAULT_BACKEND_URL || 'https://pitchbox.app',
    ),
  },
  resolve: {
    alias: {
      $ext: path.resolve(__dirname, 'src/lib'),
      $lib: path.resolve(__dirname, 'src/lib'),
      $ui: path.resolve(__dirname, 'src/lib/components/ui'),
    },
  },
  // @lucide/svelte ships `.svelte` source files in its dist; esbuild's
  // dep-prebundling can't load them. Let Vite's svelte plugin handle these
  // packages at request time instead.
  optimizeDeps: {
    exclude: ['@lucide/svelte', 'bits-ui'],
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    port: 5175,
    strictPort: true,
    cors: { origin: [/chrome-extension:\/\//] },
  },
});
