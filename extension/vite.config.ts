import path from 'node:path';
import { defineConfig } from 'vite';
import { crx } from '@crxjs/vite-plugin';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';
import manifest from './manifest.config';

export default defineConfig({
  plugins: [svelte(), tailwindcss(), crx({ manifest })],
  resolve: {
    alias: {
      $ext: path.resolve(__dirname, 'src/lib'),
    },
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
