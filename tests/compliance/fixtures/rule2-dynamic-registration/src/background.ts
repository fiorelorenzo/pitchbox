// Registers the LinkedIn content script at runtime, the way extension/src/background.ts
// does, so rule 2 has to follow the `?script` import to find the file it must scan.
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
