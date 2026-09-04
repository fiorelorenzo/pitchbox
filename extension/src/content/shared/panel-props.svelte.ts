/**
 * A reactive props object for a mounted panel.
 *
 * `.svelte.ts` rather than `.ts` because runes only compile in a module the
 * Svelte plugin processes, and this needs `$state`: Svelte 5's `mount()` does
 * **not** make the props object it is handed reactive, so assigning onto a
 * plain object notifies nothing and the component never re-renders. That is
 * exactly how `panel-host.ts`'s `update()` shipped as a silent no-op (#369),
 * with the in-page assistant unable to leave its resting state.
 *
 * Kept as its own module so `panel-host.ts` stays a plain `.ts` file that any
 * suite can import, and so the reason for the file extension has somewhere to
 * be written down.
 *
 * `$state` has to initialise a variable declaration rather than be returned
 * directly, which is why this reads the way it does.
 */
export function reactiveProps<Props extends Record<string, unknown>>(initial: Props): Props {
  const live = $state(initial);
  return live;
}
