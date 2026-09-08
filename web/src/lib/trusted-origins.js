// The one list of origins this deployment answers a mutation from, shared by
// the two checks that need it: SvelteKit's own cross-site form check
// (`csrf.trustedOrigins` in svelte.config.js) and the hook that guards
// /api/* mutations (`blocksCrossOriginMutation` in hooks.server.ts).
//
// They have to agree, and until #501 they did not. adapter-node builds
// `event.url` from the ORIGIN env var rather than from the request's Host
// header, so once ORIGIN moved to app.pitchbox.app the hook's
// `origin.host !== url.host` comparison started rejecting every browser
// still on the apex - a 403 `cross_origin_blocked` on every mutation, while
// `csrf.trustedOrigins` had already been given both hosts for exactly that
// reason. Reproduced against the deployed prod build on 2026-09-09.
//
// This is a plain .js module on purpose: svelte.config.js is loaded by Node
// before any TypeScript exists, and it cannot import from the app's TS
// sources. Keeping the list here rather than in svelte.config.js also keeps
// the runtime hook from importing @sveltejs/adapter-node, which is a
// devDependency and absent from the deployed image.
//
// Transitional: drop `pitchbox.app` and `www.pitchbox.app` once the apex has
// served the landing page, not this app, for a full release (#422, #424).
export const TRUSTED_ORIGINS = [
  'https://app.pitchbox.app',
  'https://pitchbox.app',
  'https://www.pitchbox.app',
];

/**
 * The origins a mutation's `Origin` header may carry, on top of whatever
 * origin the request itself resolved to. Compared in full rather than by
 * host, so `http://pitchbox.app` is not trusted because the https one is.
 *
 * @returns {Set<string>} normalized origins (scheme, host, port)
 */
export function trustedOriginSet() {
  const origins = new Set();
  for (const origin of TRUSTED_ORIGINS) {
    try {
      origins.add(new URL(origin).origin);
    } catch {
      // A malformed entry is a typo in the list above, not a runtime input:
      // skip it rather than failing every request on this deployment.
    }
  }
  return origins;
}
