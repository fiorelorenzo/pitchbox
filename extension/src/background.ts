import { runDmSync } from './background/dm-sync.js';

const ALARM = 'pitchbox:dm-sync';
const PERIOD_MIN = 10;

chrome.runtime.onInstalled.addListener(() => {
  console.log('[pitchbox] extension installed');
  chrome.alarms.create(ALARM, { periodInMinutes: PERIOD_MIN });
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(ALARM, { periodInMinutes: PERIOD_MIN });
});

chrome.alarms.onAlarm.addListener(async (a) => {
  if (a.name !== ALARM) return;
  const r = await runDmSync();
  if (!r.ok) console.warn('[pitchbox] dm-sync skipped:', r.reason);
  else if ((r.inserted ?? 0) > 0) console.log('[pitchbox] dm-sync:', r);
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'pitchbox:dm-sync:run') {
    runDmSync().then(sendResponse);
    return true;
  }
  return false;
});
