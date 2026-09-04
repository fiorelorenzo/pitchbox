import { hasLinkedInPermission } from '../lib/permissions.js';
import commentAssistScriptPath from '../content/linkedin-comment-assist.ts?script';

// #314's own dynamic-registration helper, mirroring background.ts's
// syncLinkedInContentScript (linkedin-comment.ts, #308-driven follow-up to
// #317) and linkedin-reply-ingest-registration.ts's own module (#307). Kept
// in its own module rather than added inline to background.ts, matching the
// established convention: a content-script registration is small, one file
// per script, so a future LinkedIn content script has exactly one place to
// add its own.
//
// Same match set as linkedin-comment.ts's own registration
// (`/feed/update/*`): the comment composer, and the stable activity URN
// this module needs to key a suggestion request on, only exist on the
// classic post-detail page - see linkedin-comment-assist.ts's own doc
// comment and linkedin-dom.ts's "Two frontends, one identifier".
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
          matches: ['https://www.linkedin.com/feed/update/*'],
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
