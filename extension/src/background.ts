import { runInboxSync } from './background/inbox-sync.js';
import { runChatSync } from './background/chat-sync.js';
import {
  getSettings,
  patchPairing,
  setSettings,
  upsertPairing,
  type SyncChannelStatus,
} from './lib/storage.js';
import { api, type DmSyncFanout } from './lib/api.js';
import { logEvent } from './lib/activity.js';
import { getSettings as getExtensionSettings } from './lib/settings.js';

const ALARM = 'pitchbox:dm-sync';

type Result = {
  ok: boolean;
  inserted?: number;
  replied?: number;
  reason?: string;
  chatStatus?: SyncChannelStatus;
  legacyStatus?: SyncChannelStatus;
};

export function classifyInbox(r: Result): SyncChannelStatus {
  if (r.ok) return 'ok';
  if (r.reason === 'not-logged-in') return 'unauthorized';
  // #178: the backend rejects our bearer token with 401 when the device was
  // revoked in Settings - surface it the same way as an unauthenticated
  // reddit.com session rather than a generic error.
  if (r.reason === 'device-revoked') return 'unauthorized';
  return 'error';
}

function classifyChat(r: Result): SyncChannelStatus {
  if (r.chatStatus) return r.chatStatus;
  if (r.ok) return 'ok';
  if (r.reason === 'no-matrix-creds') return 'unknown';
  if (r.reason === 'matrix-token-invalid') return 'unauthorized';
  return 'error';
}

// #174: runInboxSync/runChatSync already catch their own errors internally,
// but an unexpected throw here must never take down runAllSyncs and
// suppress the other poller's already-computed results, the per-pairing
// status write, the heartbeat, or the activity log.
async function safeRunInboxSync(): Promise<Result> {
  try {
    return await runInboxSync();
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
}

async function safeRunChatSync(): Promise<Result> {
  try {
    return await runChatSync();
  } catch (e) {
    return { ok: false, reason: (e as Error).message, chatStatus: 'error' };
  }
}

async function runAllSyncs() {
  const s = await getExtensionSettings();

  // Short-circuit disabled pollers - treat their slot as a no-op success so
  // the heartbeat still fires and the dashboard sees fresh status.
  const inbox: Result = s.legacyPollerEnabled
    ? await safeRunInboxSync()
    : { ok: true, inserted: 0, replied: 0 };
  const chat: Result = s.chatPollerEnabled
    ? await safeRunChatSync()
    : { ok: true, inserted: 0, replied: 0 };

  const status = {
    chat: classifyChat(chat),
    legacy: classifyInbox(inbox),
    capturedAt: new Date().toISOString(),
  };

  // Heartbeat first: it POSTs to every paired backend every cycle (even a
  // quiet one with no new Reddit activity), so its per-pairing result is our
  // reliable signal for whether that specific backend still accepts this
  // device's token. A 401 back means the device was revoked server-side.
  let heartbeat: DmSyncFanout = [];
  try {
    heartbeat = await api.dmSync('reddit', [], [], {
      chat: status.chat,
      legacy: status.legacy,
      captured_at: status.capturedAt,
    });
  } catch {
    // ignored - api.dmSync already folds per-pairing failures into its result.
  }

  // Persist a PER-PAIRING status (#178). The Reddit-channel status
  // (chat/legacy) is shared - it reflects the local Reddit session, the same
  // for every backend. The backend-token status is per pairing: a revoked
  // pairing shows 'unauthorized' even when a sibling backend is healthy, so
  // its dot is honest rather than borrowing a neighbour's green.
  const { pairings } = await getSettings();
  let anyRevoked = false;
  for (const p of pairings) {
    const hb = heartbeat.find((r) => r.backendUrl === p.backendUrl);
    const backendRevoked = !!hb && !hb.ok && hb.status === 401;
    if (backendRevoked) anyRevoked = true;
    await patchPairing(p.backendUrl, {
      syncStatus: {
        chat: status.chat,
        legacy: backendRevoked ? 'unauthorized' : status.legacy,
        capturedAt: status.capturedAt,
      },
    });
  }
  if (anyRevoked) {
    await logEvent({
      level: 'warn',
      source: 'dm-sync',
      message: 'activity.dm-sync.device-revoked',
    });
  }

  // Activity log entries - one per poller that actually ran this cycle.
  if (s.legacyPollerEnabled) {
    if (inbox.ok) {
      await logEvent({
        level: 'info',
        source: 'dm-sync',
        message: 'activity.dm-sync.ok',
        messageParams: {
          inserted: inbox.inserted ?? 0,
          replied: inbox.replied ?? 0,
        },
      });
    } else if (inbox.reason === 'not-logged-in' || inbox.reason === 'device-revoked') {
      await logEvent({
        level: 'warn',
        source: 'dm-sync',
        message: 'activity.dm-sync.unauthorized',
        messageParams: { reason: inbox.reason ?? 'unknown' },
      });
    } else {
      await logEvent({
        level: 'error',
        source: 'dm-sync',
        message: 'activity.dm-sync.error',
        messageParams: { reason: inbox.reason ?? 'unknown' },
      });
    }
  }
  if (s.chatPollerEnabled) {
    if (chat.ok) {
      await logEvent({
        level: 'info',
        source: 'chat-sync',
        message: 'activity.chat-sync.ok',
        messageParams: {
          messages: chat.inserted ?? 0,
          inserted: chat.inserted ?? 0,
        },
      });
    } else if (chat.reason === 'matrix-token-invalid') {
      await logEvent({
        level: 'warn',
        source: 'chat-sync',
        message: 'activity.chat-sync.unauthorized',
        messageParams: { reason: chat.reason ?? 'unknown' },
      });
    } else if (chat.reason === 'no-matrix-creds') {
      // Quietly skip - no creds yet means the user has not paired Reddit Chat.
    } else {
      await logEvent({
        level: 'error',
        source: 'chat-sync',
        message: 'activity.chat-sync.error',
        messageParams: { reason: chat.reason ?? 'unknown' },
      });
    }
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

/**
 * Re-apply the sync alarm from current extension settings. Clears the alarm
 * first so the new period takes effect immediately rather than waiting out
 * the old interval. If both pollers are disabled, the alarm stays cleared.
 */
async function applyAlarms(): Promise<void> {
  const s = await getExtensionSettings();
  await chrome.alarms.clear(ALARM);
  if (s.legacyPollerEnabled || s.chatPollerEnabled) {
    chrome.alarms.create(ALARM, { periodInMinutes: s.syncIntervalMin });
  }
  await logEvent({
    level: 'info',
    source: 'system',
    message: 'activity.system.alarms-applied',
    messageParams: { interval: s.syncIntervalMin },
  });
}

// #203: exported so tests can drive the install/update branch directly
// without going through chrome.runtime.onInstalled's listener plumbing.
export async function handleInstalled(details: chrome.runtime.InstalledDetails): Promise<void> {
  console.log('[pitchbox] extension installed:', details.reason);
  // Register side panel behaviour - guarded for older Chrome builds without
  // the sidePanel API.
  try {
    await chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true });
  } catch (err) {
    console.warn('[pitchbox] sidePanel.setPanelBehavior failed:', err);
  }
  await applyAlarms();
  if (details.reason === 'update') {
    await logEvent({
      level: 'info',
      source: 'system',
      message: 'activity.system.upgraded',
      messageParams: {
        from: details.previousVersion ?? 'unknown',
        to: chrome.runtime.getManifest().version,
      },
    });
  } else if (details.reason === 'install') {
    await logEvent({ level: 'info', source: 'system', message: 'activity.system.installed' });
  } else {
    // chrome_update / shared_module_update: preserve the prior generic boot
    // log rather than inventing a distinct message for these edge reasons.
    await logEvent({ level: 'info', source: 'system', message: 'activity.system.boot' });
  }
}

chrome.runtime.onInstalled.addListener(handleInstalled);

chrome.runtime.onStartup.addListener(async () => {
  await logEvent({ level: 'info', source: 'system', message: 'activity.system.boot' });
  await applyAlarms();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (!('extensionSettings' in changes)) return;
  void applyAlarms();
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
    runAllSyncs()
      .then((r) => sendResponse(aggregate(r)))
      .catch((e) => sendResponse({ ok: false, reason: (e as Error).message }));
    return true;
  }
  if (msg?.type === 'pitchbox:chat-creds') {
    (async () => {
      const prior = await getSettings();
      const tokenChanged = msg.matrixToken && prior.matrixToken !== msg.matrixToken;
      await setSettings({
        matrixUserId: msg.matrixUserId,
        matrixDeviceId: msg.matrixDeviceId,
        matrixToken: msg.matrixToken,
      });
      sendResponse({ ok: true });
      // When the Matrix token actually rotated (typical after the user
      // refreshes reddit.com to clear an `unauthorized` state), kick off
      // an immediate sync so the dashboard banner clears without waiting
      // for the next alarm tick.
      if (tokenChanged) {
        runAllSyncs().catch(() => {
          // Ignore failures; the regular alarm will retry shortly.
        });
      }
    })();
    return true;
  }
  if (msg?.type === 'pitchbox:auto-pair') {
    // Persist token captured from the dashboard auto-pair handshake. Stored
    // alongside any other pairings so cloud + self-hosted can coexist.
    const { backendUrl, token, orgName, deviceLabel } = msg as {
      backendUrl: string;
      token: string;
      orgName?: string;
      deviceLabel?: string;
    };
    if (typeof backendUrl !== 'string' || typeof token !== 'string') {
      sendResponse({ ok: false, reason: 'invalid_payload' });
      return false;
    }
    upsertPairing({
      backendUrl: backendUrl.replace(/\/$/, ''),
      token,
      orgName: typeof orgName === 'string' ? orgName : undefined,
      deviceLabel: typeof deviceLabel === 'string' ? deviceLabel : undefined,
      lastHandshakeAt: new Date().toISOString(),
      // #186: this pairing came from the passive auto-pair content script
      // with no user confirmation - leave consentAckAt unset so
      // ConnectionCard's review banner surfaces it the next time the side
      // panel is opened.
    }).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg?.type === 'pitchbox:log') {
    // Centralised log dispatcher - UI surfaces (side panel, content scripts)
    // POST events here so the service worker is the single writer.
    logEvent(msg.event).then(() => sendResponse({ ok: true }));
    return true;
  }
  return false;
});
