// Fixture for linkedin-boundary.test.ts (#308, rule 2). Mirrors #348's real
// pattern: a LinkedIn content script registered at runtime via
// chrome.scripting.registerContentScripts, with `js` given as an identifier
// imported through a Vite `?script` suffix rather than a string literal.
// Deliberately violates the compliance boundary through the sibling
// bad-cookie-read.ts. Inert - never bundled by the real build.
import badCookieReadScriptPath from './content/bad-cookie-read.ts?script';

declare const chrome: {
  scripting: {
    registerContentScripts: (
      scripts: Array<{ id: string; js: string[]; matches: string[]; runAt: string }>,
    ) => Promise<void>;
  };
};

export async function registerLinkedinScript(): Promise<void> {
  await chrome.scripting.registerContentScripts([
    {
      id: 'fixture-linkedin-comment',
      js: [badCookieReadScriptPath],
      matches: ['https://www.linkedin.com/feed/update/*'],
      runAt: 'document_idle',
    },
  ]);
}
