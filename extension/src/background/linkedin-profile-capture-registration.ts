import { hasLinkedInPermission } from '../lib/permissions.js';
import profileCaptureScriptPath from '../content/linkedin-profile-capture.ts?script';

// LI-21 (2026-09-07): dynamic registration for linkedin-profile-capture.ts,
// mirroring linkedin-reply-ingest-registration.ts's own shape - kept in its
// own module rather than added to background.ts because that file is owned
// by PanelContent this wave (see the PR body's wiring note). The one call
// this needs (registerLinkedInProfileCaptureScript, invoked from the same
// trigger sites syncLinkedInContentScripts already uses: onInstalled,
// onStartup, permissions.onAdded, permissions.onRemoved) is added there by
// PanelContent once this file exists.
//
// Matches `/in/*` only: that single pattern covers both the profile page
// itself (`/in/<slug>/`) and its `recent-activity` sibling
// (`/in/<slug>/recent-activity/*`), which is where `readOwnPosts` reads
// voice samples from - see linkedin-profile-capture.ts's own doc comment.
const LINKEDIN_PROFILE_CAPTURE_SCRIPT_ID = 'pitchbox-linkedin-profile-capture';

export async function registerLinkedInProfileCaptureScript(): Promise<void> {
  try {
    const [granted, existing] = await Promise.all([
      hasLinkedInPermission(),
      chrome.scripting.getRegisteredContentScripts({
        ids: [LINKEDIN_PROFILE_CAPTURE_SCRIPT_ID],
      }),
    ]);
    if (granted && existing.length === 0) {
      await chrome.scripting.registerContentScripts([
        {
          id: LINKEDIN_PROFILE_CAPTURE_SCRIPT_ID,
          js: [profileCaptureScriptPath],
          // Every LinkedIn page, not the URL shapes this script acts on:
          // LinkedIn's own nav changes route with `history.pushState`, which
          // injects nothing, so a narrow match leaves the script absent from
          // a surface the human reached by clicking (2026-09-08, #438). The
          // script gates itself; the LinkedIn grant is already host-wide.
          matches: ['https://www.linkedin.com/*'],
          runAt: 'document_idle',
        },
      ]);
    } else if (!granted && existing.length > 0) {
      await chrome.scripting.unregisterContentScripts({
        ids: [LINKEDIN_PROFILE_CAPTURE_SCRIPT_ID],
      });
    }
  } catch (err) {
    console.warn('[pitchbox] registerLinkedInProfileCaptureScript failed:', err);
  }
}
