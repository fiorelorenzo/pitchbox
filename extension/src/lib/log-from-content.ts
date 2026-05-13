import type { ActivityEvent } from './activity.js';

/**
 * Forward an activity event from a content script to the service worker.
 * The SW is the single writer for `activityLog` in chrome.storage.local; content
 * scripts use this helper instead of importing `lib/activity.ts` directly.
 */
export function logFromContent(event: Omit<ActivityEvent, 'id' | 'ts'>): void {
  try {
    chrome.runtime.sendMessage({ type: 'pitchbox:log', event });
  } catch {
    // Worker may be sleeping or the extension context invalidated; drop silently.
  }
}
