/**
 * The content scripts that render a Svelte panel, and the paths they are
 * emitted at. Runtime-safe on purpose: the build plugin that emits them
 * (`extension/build/panel-content-scripts.ts`) imports this list, and the
 * background worker that registers them imports the same list, so the two
 * cannot drift. Nothing here may import from `vite` or `node:*`, because this
 * module ends up in the extension bundle.
 *
 * Why these are not in crxjs's `contentScripts.standaloneFiles` like every
 * other dynamically registered script: crxjs builds those through a nested
 * Vite build with `plugins: []`, so `svelte()` never runs and a panel-bearing
 * script fails to parse (#369).
 */
export const PANEL_CONTENT_SCRIPTS = [
  'src/content/linkedin-comment-assist.ts',
  'src/content/linkedin-post-assist.ts',
] as const;

/**
 * The emitted path for a source entry, relative to the extension root, which
 * is also what `chrome.scripting.registerContentScripts` takes.
 */
export function panelScriptOutput(entry: string): string {
  return entry.replace(/\.ts$/, '.js');
}
