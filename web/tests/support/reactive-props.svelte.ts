// A props object a test can mutate after `mount`, which plain object
// literals cannot be: Svelte 5 only re-runs a component's `$props()` reads
// when the source it was handed is reactive. Runes are compiled in a
// `.svelte.ts` module (vite-plugin-svelte's compile-module pass, which the
// root `vitest.config.ts` already runs), and a `.ts` test file is not, so
// the `$state` call has to live here.
//
// Used to drive the "upstream prop changed" half of a component's contract -
// what a real `invalidateAll()` delivers - without a SvelteKit router.
export function reactiveProps<T extends object>(initial: T): T {
  const props = $state(initial);
  return props;
}
