export { DESCRIPTION_SCAFFOLD, SCAFFOLD_SECTIONS, type ScaffoldSection } from './scaffold.js';
export { assertSafeGitCloneUrl } from './git-url.js';
// `git-remote.ts` is deliberately NOT re-exported here. This barrel is
// imported by client code (ProjectOverviewTab.svelte reads
// DESCRIPTION_SCAFFOLD from it), and `git-remote.ts` imports
// `node:child_process`, which Vite externalizes for the browser: adding it
// here put a "Cannot access node:child_process.spawn in client code" error
// on the project page. Server-side callers import
// `./project-extraction/git-remote.js` by path.
