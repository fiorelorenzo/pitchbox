import { hasLinkedInPermission } from '../lib/permissions.js';
import replyIngestScriptPath from '../content/linkedin-reply-ingest.ts?script';

// #307's own dynamic-registration helper for linkedin-reply-ingest.ts,
// mirroring the shape and gating of background.ts's own
// syncLinkedInContentScript (for linkedin-comment.ts, #308-driven follow-up
// to #317). Kept in its own module, not added to background.ts, purely
// because of this wave's file ownership split: #302 (ObservationCollector)
// owns background.ts this wave. This function is real, working code - it
// is exactly what a call inside background.ts's syncLinkedInContentScripts
// wrapper (#302's PR #363) needs to invoke, at the same trigger sites
// syncLinkedInContentScript already uses (onInstalled, onStartup,
// permissions.onAdded, permissions.onRemoved) - see the PR body's wiring
// note, since neither worktree can safely add that call to a file owned by
// the other.
const LINKEDIN_REPLY_INGEST_SCRIPT_ID = 'pitchbox-linkedin-reply-ingest';

export async function registerLinkedInReplyIngestScript(): Promise<void> {
  try {
    const [granted, existing] = await Promise.all([
      hasLinkedInPermission(),
      chrome.scripting.getRegisteredContentScripts({ ids: [LINKEDIN_REPLY_INGEST_SCRIPT_ID] }),
    ]);
    if (granted && existing.length === 0) {
      await chrome.scripting.registerContentScripts([
        {
          id: LINKEDIN_REPLY_INGEST_SCRIPT_ID,
          js: [replyIngestScriptPath],
          matches: [
            'https://www.linkedin.com/feed/update/*',
            'https://www.linkedin.com/notifications*',
            'https://www.linkedin.com/messaging*',
          ],
          runAt: 'document_idle',
        },
      ]);
    } else if (!granted && existing.length > 0) {
      await chrome.scripting.unregisterContentScripts({ ids: [LINKEDIN_REPLY_INGEST_SCRIPT_ID] });
    }
  } catch (err) {
    console.warn('[pitchbox] registerLinkedInReplyIngestScript failed:', err);
  }
}
