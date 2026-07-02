import adapter from '@sveltejs/adapter-node';

/** @type {import('@sveltejs/kit').Config} */
const config = {
  compilerOptions: {
    // Force runes mode for the project, except for libraries. Can be removed in svelte 6.
    runes: ({ filename }) => (filename.split(/[/\\]/).includes('node_modules') ? undefined : true),
  },
  kit: {
    // adapter-node: Pitchbox is self-hosted, so we build a standalone Node server
    // (`build/index.js`). It is run under `node --import tsx` so the externalized
    // `@pitchbox/*` TS source (and its CJS deps) load from node_modules unbundled.
    adapter: adapter(),
  },
};

export default config;
