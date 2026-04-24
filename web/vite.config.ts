import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [tailwindcss(), sveltekit()],
  server: { host: '127.0.0.1', port: Number(process.env.WEB_PORT ?? 5180), strictPort: true },
  ssr: {
    // Packages that ship `.svelte` source files must be bundled by Vite for SSR
    // instead of being loaded by Node as ESM.
    noExternal: ['svelte-sonner', 'bits-ui', 'lucide-svelte'],
  },
});
