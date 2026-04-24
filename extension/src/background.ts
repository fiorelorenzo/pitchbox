import { runDmSync } from './background/dm-sync.js';
import { runChatSync } from './background/chat-sync.js';
import { setSettings } from './lib/storage.js';

const ALARM = 'pitchbox:dm-sync';
const PERIOD_MIN = 10;

type Result = { ok: boolean; inserted?: number; replied?: number; reason?: string };

async function runAllSyncs() {
  const dm = await runDmSync();
  const chat = await runChatSync();
  return { dm, chat };
}

function aggregate(r: { dm: Result; chat: Result }): Result {
  const inserted = (r.dm.ok ? (r.dm.inserted ?? 0) : 0) + (r.chat.ok ? (r.chat.inserted ?? 0) : 0);
  const replied = (r.dm.ok ? (r.dm.replied ?? 0) : 0) + (r.chat.ok ? (r.chat.replied ?? 0) : 0);
  const reasons: string[] = [];
  if (!r.dm.ok) reasons.push(`pm:${r.dm.reason}`);
  if (!r.chat.ok && r.chat.reason !== 'no-matrix-creds') reasons.push(`chat:${r.chat.reason}`);
  return {
    ok: r.dm.ok || r.chat.ok,
    inserted,
    replied,
    reason: reasons.join(', ') || undefined,
  };
}

chrome.runtime.onInstalled.addListener(() => {
  console.log('[pitchbox] extension installed');
  chrome.alarms.create(ALARM, { periodInMinutes: PERIOD_MIN });
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(ALARM, { periodInMinutes: PERIOD_MIN });
});

chrome.alarms.onAlarm.addListener(async (a) => {
  if (a.name !== ALARM) return;
  const r = await runAllSyncs();
  const agg = aggregate(r);
  if (!agg.ok) console.warn('[pitchbox] sync skipped:', agg.reason);
  else if ((agg.inserted ?? 0) > 0) console.log('[pitchbox] sync:', agg);
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'pitchbox:dm-sync:run') {
    runAllSyncs().then((r) => sendResponse(aggregate(r)));
    return true;
  }
  if (msg?.type === 'pitchbox:chat-creds') {
    setSettings({
      matrixUserId: msg.matrixUserId,
      matrixDeviceId: msg.matrixDeviceId,
      matrixToken: msg.matrixToken,
    }).then(() => sendResponse({ ok: true }));
    return true;
  }
  return false;
});
