// Fixture for linkedin-boundary.test.ts (#308, rule 4). Registers a
// chrome.alarms handler whose call graph reaches ./linkedin/poll.ts.
// Deliberately violates the compliance boundary. Inert - never bundled.
import { pollFromLinkedin } from './linkedin/poll.js';

declare const chrome: {
  alarms: { onAlarm: { addListener: (fn: (alarm: unknown) => void) => void } };
};

async function runSync(): Promise<void> {
  await pollFromLinkedin();
}

chrome.alarms.onAlarm.addListener(async () => {
  await runSync();
});
