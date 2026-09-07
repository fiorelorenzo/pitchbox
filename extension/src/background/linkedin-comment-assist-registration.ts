import { hasLinkedInPermission } from '../lib/permissions.js';
import { PANEL_CONTENT_SCRIPTS, panelScriptOutput } from '../content/panel-scripts.js';

// Not a `?script` import, unlike its two siblings. `?script` is crxjs's own
// mechanism and resolves to a file crxjs emitted, and crxjs cannot build this
// one: its nested IIFE build runs `plugins: []`, so the Svelte panel this
// script renders fails to parse (#369). The build plugin in
// `extension/build/panel-content-scripts.ts` emits it instead, at exactly the
// path below, and both sides read the same list so they cannot drift.
const commentAssistScriptPath = panelScriptOutput(PANEL_CONTENT_SCRIPTS[0]);

// #314's own dynamic-registration helper, mirroring background.ts's
// syncLinkedInContentScript (linkedin-comment.ts, #308-driven follow-up to
// #317) and linkedin-reply-ingest-registration.ts's own module (#307). Kept
// in its own module rather than added inline to background.ts, matching the
// established convention: a content-script registration is small, one file
// per script, so a future LinkedIn content script has exactly one place to
// add its own.
//
// Same match set as linkedin-comment.ts's own registration, plus `/feed/*`
// (2026-09-07): the classic post-detail page's own composer and stable
// activity URN - see linkedin-comment-assist.ts's own doc comment and
// linkedin-dom.ts's "Two frontends, one identifier" - and the main feed,
// where the assistant now wires a composer per card, with no urn to key on
// there (decision 1/2 of the 2026-09-07 overlay/feed rework).
//
// `/posts/*` belongs in that set as much as `/feed/update/*` (#379). It is the
// canonical post URL: LinkedIn's own "Copia link al post" hands it out, a
// shared link resolves to it, and content search results open it. Measured on
// a real signed-in page: it serves the classic frontend, carries
// `[role="article"][data-urn]` and holds the comment composer, so registering
// only `/feed/update/*` left the assistant absent from the page a human is
// most likely to be reading.
// The literal array is deliberate: tests/compliance/linkedin-boundary.ts
// rule 2 derives its scan set from the text of this initializer, so hoisting
// it into a shared constant would silently drop this file out of the check.
const LINKEDIN_COMMENT_ASSIST_SCRIPT_ID = 'pitchbox-linkedin-comment-assist';

export async function registerLinkedInCommentAssistScript(): Promise<void> {
  try {
    const [granted, existing] = await Promise.all([
      hasLinkedInPermission(),
      chrome.scripting.getRegisteredContentScripts({
        ids: [LINKEDIN_COMMENT_ASSIST_SCRIPT_ID],
      }),
    ]);
    if (granted && existing.length === 0) {
      await chrome.scripting.registerContentScripts([
        {
          id: LINKEDIN_COMMENT_ASSIST_SCRIPT_ID,
          js: [commentAssistScriptPath],
          matches: [
            'https://www.linkedin.com/feed/update/*',
            'https://www.linkedin.com/posts/*',
            'https://www.linkedin.com/feed/*',
          ],
          runAt: 'document_idle',
        },
      ]);
    } else if (!granted && existing.length > 0) {
      await chrome.scripting.unregisterContentScripts({
        ids: [LINKEDIN_COMMENT_ASSIST_SCRIPT_ID],
      });
    }
  } catch (err) {
    console.warn('[pitchbox] registerLinkedInCommentAssistScript failed:', err);
  }
}
