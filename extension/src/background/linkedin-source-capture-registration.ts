import { hasLinkedInPermission } from '../lib/permissions.js';
import sourceCaptureScriptPath from '../content/linkedin-source-capture.ts?script';

// #436's own dynamic-registration helper for linkedin-source-capture.ts,
// mirroring linkedin-profile-capture-registration.ts's own shape. Kept in
// its own module rather than added inline to background.ts, matching the
// established convention: a content-script registration is small, one file
// per script, so a future LinkedIn content script has exactly one place to
// add its own.
//
// Every LinkedIn page, not just a post-detail or profile URL: LinkedIn's own
// nav changes route with `history.pushState`, which injects nothing, so a
// narrow match would leave the script absent from a surface the human
// reached by clicking (2026-09-08, #438). The script gates itself
// (`currentPageMatch`); the LinkedIn grant is already host-wide.
const LINKEDIN_SOURCE_CAPTURE_SCRIPT_ID = 'pitchbox-linkedin-source-capture';

export async function registerLinkedInSourceCaptureScript(): Promise<void> {
  try {
    const [granted, existing] = await Promise.all([
      hasLinkedInPermission(),
      chrome.scripting.getRegisteredContentScripts({
        ids: [LINKEDIN_SOURCE_CAPTURE_SCRIPT_ID],
      }),
    ]);
    if (granted && existing.length === 0) {
      await chrome.scripting.registerContentScripts([
        {
          id: LINKEDIN_SOURCE_CAPTURE_SCRIPT_ID,
          js: [sourceCaptureScriptPath],
          matches: ['https://www.linkedin.com/*'],
          runAt: 'document_idle',
        },
      ]);
    } else if (!granted && existing.length > 0) {
      await chrome.scripting.unregisterContentScripts({
        ids: [LINKEDIN_SOURCE_CAPTURE_SCRIPT_ID],
      });
    }
  } catch (err) {
    console.warn('[pitchbox] registerLinkedInSourceCaptureScript failed:', err);
  }
}
