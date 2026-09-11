// Test-only stand-in for SvelteKit's `$app/stores`. The real module (see
// `@sveltejs/kit/src/runtime/app/stores.js`) reads its value off the live
// client router's context, which only exists once SvelteKit's own Vite
// plugin has bootstrapped a page - this repo's root `vitest.config.ts` only
// wires the `svelte()` plugin (see its own comment on `conditions:
// ['browser']`), so a component test that mounts a dashboard component
// pulling in `$app/stores` needs something concrete to resolve to instead.
//
// `resolve.alias` in `vitest.config.ts` points the literal `$app/stores`
// specifier at this file, so every component under test that imports `page`
// from `$app/stores` shares this exact module instance. A test sets what
// `$page` reports by importing `__page` from this same path (not through the
// alias) and calling `.set(...)` before mounting.
import { writable } from 'svelte/store';

export type TestPageData = { data: Record<string, unknown> };

export const __page = writable<TestPageData>({ data: { locale: 'en' } });
export const page = __page;
export const navigating = writable(null);
export const updated = {
  subscribe: writable(false).subscribe,
  check: async () => false,
};
