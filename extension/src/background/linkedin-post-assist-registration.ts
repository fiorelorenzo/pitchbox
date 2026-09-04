import { hasLinkedInPermission } from '../lib/permissions.js';
import { PANEL_CONTENT_SCRIPTS, panelScriptOutput } from '../content/panel-scripts.js';

// Not a `?script` import, matching linkedin-comment-assist-registration.ts's
// own reasoning: `?script` is crxjs's own mechanism and resolves to a file
// crxjs emitted, and crxjs cannot build this one - its nested IIFE build
// runs `plugins: []`, so the Svelte panel this script renders fails to parse
// (#369). The build plugin in `extension/build/panel-content-scripts.ts`
// emits it instead, at exactly the path below, and both sides read the same
// list so they cannot drift.
const postAssistScriptPath = panelScriptOutput(PANEL_CONTENT_SCRIPTS[1]);

// #315's own dynamic-registration helper, mirroring
// linkedin-comment-assist-registration.ts (#314) and
// linkedin-reply-ingest-registration.ts (#307). Kept in its own module for
// the same reason those are: a content-script registration is small, one
// file per script, so a future LinkedIn content script has exactly one place
// to add its own.
//
// Matches the feed rather than the post-detail-only set the comment assist
// registers against: LinkedIn's "Start a post" composer is reachable from
// the top of the main feed, not from a single post's own page - see
// linkedin-post-assist.ts's own doc comment.
const LINKEDIN_POST_ASSIST_SCRIPT_ID = 'pitchbox-linkedin-post-assist';

export async function registerLinkedInPostAssistScript(): Promise<void> {
  try {
    const [granted, existing] = await Promise.all([
      hasLinkedInPermission(),
      chrome.scripting.getRegisteredContentScripts({
        ids: [LINKEDIN_POST_ASSIST_SCRIPT_ID],
      }),
    ]);
    if (granted && existing.length === 0) {
      await chrome.scripting.registerContentScripts([
        {
          id: LINKEDIN_POST_ASSIST_SCRIPT_ID,
          js: [postAssistScriptPath],
          matches: ['https://www.linkedin.com/feed*'],
          runAt: 'document_idle',
        },
      ]);
    } else if (!granted && existing.length > 0) {
      await chrome.scripting.unregisterContentScripts({
        ids: [LINKEDIN_POST_ASSIST_SCRIPT_ID],
      });
    }
  } catch (err) {
    console.warn('[pitchbox] registerLinkedInPostAssistScript failed:', err);
  }
}
