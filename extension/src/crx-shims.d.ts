// @crxjs/vite-plugin's `?script`/`?iife` import suffix resolves, at build
// time, to the built output path of a file registered for dynamic
// injection via chrome.scripting - see background.ts's
// `linkedinCommentScriptPath` import and syncLinkedInContentScript's doc
// comment. The plugin has no ambient type declarations of its own for
// these (unlike `?raw`/`?url`, which vite/client already covers), so
// without this, tsc/svelte-check can't resolve the module shape.
declare module '*.ts?script' {
  const path: string;
  export default path;
}

declare module '*.ts?iife' {
  const path: string;
  export default path;
}
