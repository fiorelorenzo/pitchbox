import { defineConfig } from 'vite';
import { crx } from '@crxjs/vite-plugin';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';
import manifest from './manifest.config';

export default defineConfig({
  plugins: [svelte(), tailwindcss(), crx({ manifest })],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    // Default Vite port (5173) is left free for the user's other projects.
    port: 5175,
    strictPort: true,
    cors: { origin: [/chrome-extension:\/\//] },
  },
});
