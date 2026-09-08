import path from 'node:path';
import { defineConfig } from 'vite';
import { crx } from '@crxjs/vite-plugin';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';
import manifest from './manifest.config';
import { panelContentScripts } from './vite-plugins/panel-content-scripts';
import pkg from './package.json' with { type: 'json' };

export default defineConfig({
  plugins: [
    svelte(),
    tailwindcss(),
    crx({
      manifest,
      // linkedin-comment.ts is never declared in manifest.config.ts's static
      // content_scripts (that would grant the LinkedIn host permission at
      // install, exactly what #317's optional-permission model avoids) - it
      // is registered dynamically instead, once the user grants the LinkedIn
      // permission (see background.ts's syncLinkedInContentScript). A
      // dynamically-registered MV3 content script can't be an ES module, so
      // this forces it to build as a standalone IIFE, resolved at runtime
      // through the `?script` import in background.ts (see
      // https://crxjs.dev/concepts/content and the `contentScripts` option
      // in @crxjs/vite-plugin).
      contentScripts: {
        standaloneFiles: [
          'src/content/linkedin-comment.ts',
          'src/content/linkedin-observe.ts',
          'src/content/linkedin-reply-ingest.ts',
          // The persona capture (#389). Same shape as the three above: no
          // panel, registered dynamically once the LinkedIn permission is
          // granted, so it has to be built as a standalone IIFE or the
          // registration resolves a path that does not exist in `dist`
          // (exactly the #379 defect, caught here by
          // `tests/extension-packaged-build.test.ts`).
          'src/content/linkedin-profile-capture.ts',
          // The pending project-source fill (#436, spike #435's "Plane
          // 3"). Same shape and same reason as the entry above.
          'src/content/linkedin-source-capture.ts',
        ],
      },
    }),
    // The panel-bearing scripts cannot go in the list above: crxjs builds
    // those with `plugins: []`, so a Svelte component in one fails to parse
    // (#369). They are built with the same IIFE shape by this plugin instead,
    // which does run svelte(). PANEL_CONTENT_SCRIPTS is the single list it and
    // background.ts's registration both read.
    panelContentScripts(),
  ],
  define: {
    'import.meta.env.VITE_APP_VERSION': JSON.stringify(pkg.version),
    // The backend the extension defaults to on a fresh install. Overridable at
    // build time for a self-hosted or preview build; the user can also add
    // other backends at runtime from the side panel. See docs/extension-connection-design.md.
    //
    // A plain identifier, not `import.meta.env.VITE_DEFAULT_BACKEND_URL`
    // (#445): Vite owns `import.meta.env` for `VITE_`-prefixed names and
    // fills it from `.env` files rather than the process environment, so a
    // define under that key was silently dropped and every build carried the
    // production fallback no matter what the environment said. `VITE_` also
    // stays out of this name deliberately, so it cannot be reclaimed by that
    // same mechanism later.
    __PITCHBOX_DEFAULT_BACKEND_URL__: JSON.stringify(
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
