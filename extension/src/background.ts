import { runInboxSync } from './background/inbox-sync.js';
import { runChatSync } from './background/chat-sync.js';
import { setSettings, type SyncChannelStatus } from './lib/storage.js';
import { api } from './lib/api.js';

const ALARM = 'pitchbox:dm-sync';
const PERIOD_MIN = 10;

type Result = {
  ok: boolean;
  inserted?: number;
  replied?: number;
  reason?: string;
  chatStatus?: SyncChannelStatus;
  legacyStatus?: SyncChannelStatus;
};

function classifyInbox(r: Result): SyncChannelStatus {
  if (r.ok) return 'ok';
  if (r.reason === 'not-logged-in') return 'unauthorized';
  return 'error';
}

function classifyChat(r: Result): SyncChannelStatus {
  if (r.chatStatus) return r.chatStatus;
  if (r.ok) return 'ok';
  if (r.reason === 'no-matrix-creds') return 'unknown';
  if (r.reason === 'matrix-token-invalid') return 'unauthorized';
  return 'error';
}

async function runAllSyncs() {
  const inbox = await runInboxSync();
  const chat = await runChatSync();
  const status = {
    chat: classifyChat(chat),
    legacy: classifyInbox(inbox),
    capturedAt: new Date().toISOString(),
  };
  await setSettings({ syncStatus: status });
  // Heartbeat: report current channel status to the dashboard even when no
  // items moved. Fire-and-forget — failures here are non-fatal and the next
  // alarm tick will retry.
  try {
    await api.dmSync('reddit', [], [], {
      chat: status.chat,
      legacy: status.legacy,
      captured_at: status.capturedAt,
    });
  } catch {
    // ignored
  }
  return { inbox, chat };
}

function aggregate(r: { inbox: Result; chat: Result }): Result {
  const inserted =
    (r.inbox.ok ? (r.inbox.inserted ?? 0) : 0) + (r.chat.ok ? (r.chat.inserted ?? 0) : 0);
  const replied =
    (r.inbox.ok ? (r.inbox.replied ?? 0) : 0) + (r.chat.ok ? (r.chat.replied ?? 0) : 0);
  const reasons: string[] = [];
  if (!r.inbox.ok) reasons.push(`inbox:${r.inbox.reason}`);
  if (!r.chat.ok && r.chat.reason !== 'no-matrix-creds') reasons.push(`chat:${r.chat.reason}`);
  return {
    ok: r.inbox.ok || r.chat.ok,
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
