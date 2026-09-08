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
// Registered against every LinkedIn page, not the three URL shapes the
// assistant actually acts on, and that breadth is the fix for a real defect
// rather than laziness (2026-09-08, #438). A registered content script is
// injected when a *document loads* at a matching URL. LinkedIn is a
// single-page app whose own global nav is a `<button>` calling
// `history.pushState`: measured in a signed-in Chrome, clicking Home from a
// profile page lands on `/feed/` with no document load, so a script matched
// on `/feed/*` alone is never injected and the assistant is simply absent
// from the surface the human uses most. Arriving at the same URL by typing
// it works, which is exactly why this looked like it worked.
//
// The script itself decides where it acts: `init` scans for post cards and
// finds none anywhere else, and the post-detail diagnostic is gated on
// `detectPageKind`. Breadth costs no new permission either - the LinkedIn
// grant is already host-wide (`*://*.linkedin.com/*`, #317).
//
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
          matches: ['https://www.linkedin.com/*'],
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
