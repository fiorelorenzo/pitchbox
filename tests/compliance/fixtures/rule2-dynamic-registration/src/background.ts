// Registers the LinkedIn content script at runtime, the way extension/src/background.ts
// does, so rule 2 has to follow the `?script` import to find the file it must scan.
// Declared locally rather than pulling in the webextension globals: this file is a
// fixture outside extension/, where eslint applies no browser-extension env, and the
// checker only reads the call's shape.
declare const chrome: {
  scripting: { registerContentScripts(scripts: unknown[]): Promise<void> };
};

import linkedinCommentScriptPath from './content/linkedin-comment.ts?script';

export async function syncLinkedInContentScript(): Promise<void> {
  await chrome.scripting.registerContentScripts([
    {
      id: 'pitchbox-linkedin-comment',
      js: [linkedinCommentScriptPath],
      matches: ['https://www.linkedin.com/feed/update/*'],
      runAt: 'document_idle',
    },
  ]);
}
