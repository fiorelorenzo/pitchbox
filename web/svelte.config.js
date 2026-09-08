import adapter from '@sveltejs/adapter-node';

// The app moved off the apex to app.pitchbox.app (#424). adapter-node's
// ORIGIN env var (see PUBLIC_WEB_ORIGIN in .env.docker.example) is what
// SvelteKit's cross-site form-submission check compares an incoming
// request's Origin header against; a mismatch fails closed with a 403
// ("Cross-site POST form submissions are forbidden") and nothing points at
// a stale ORIGIN as the cause. The two manual cutover steps - flipping
// Caddy/DNS to app.pitchbox.app and updating the deployed ORIGIN to match -
// cannot be made atomic, so trustedOrigins covers the gap regardless of
// which one lands first. Transitional: drop `pitchbox.app` and
// `www.pitchbox.app` once the apex has served the landing page, not this
// app, for a full release.
const TRUSTED_ORIGINS = [
  'https://app.pitchbox.app',
  'https://pitchbox.app',
  'https://www.pitchbox.app',
];

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
    csrf: {
      trustedOrigins: TRUSTED_ORIGINS,
    },
  },
};

export { TRUSTED_ORIGINS };
export default config;
