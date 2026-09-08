import { ulid } from './ulid.js';

export type ActivityLevel = 'info' | 'warn' | 'error';
export type ActivitySource =
  | 'pairing'
  | 'dm-sync'
  | 'chat-sync'
  | 'matrix-token'
  | 'reddit-action'
  | 'linkedin-dom'
  | 'linkedin-action'
  | 'linkedin-collector'
  | 'settings'
  | 'system';

export type ActivityEvent = {
  id: string;
  ts: string;
  level: ActivityLevel;
  source: ActivitySource;
  message: string;
  messageParams?: Record<string, string | number>;
  backendUrl?: string;
  meta?: Record<string, unknown>;
};

export const ACTIVITY_LOG_CAP = 500;
const KEY = 'activityLog';
const META_KEY = 'activityLogMeta';

/** Persisted alongside the entries so a dropped count survives a service-worker restart. */
type ActivityLogMeta = {
  droppedCount: number;
};

/** Facts about the ring buffer's eviction state, derived for display and export. */
export type ActivityLogStats = {
  droppedCount: number;
  oldestRetainedTs: string | null;
  cap: number;
};

async function read(): Promise<ActivityEvent[]> {
  const out = (await chrome.storage.local.get(KEY)) as { activityLog?: ActivityEvent[] };
  return Array.isArray(out.activityLog) ? out.activityLog : [];
}

async function readMeta(): Promise<ActivityLogMeta> {
  const out = (await chrome.storage.local.get(META_KEY)) as {
    activityLogMeta?: ActivityLogMeta;
  };
  const meta = out.activityLogMeta;
  return meta && typeof meta.droppedCount === 'number' ? meta : { droppedCount: 0 };
}

export async function logEvent(input: Omit<ActivityEvent, 'id' | 'ts'>): Promise<ActivityEvent> {
  const ev: ActivityEvent = { id: ulid(), ts: new Date().toISOString(), ...input };
  const current = await read();
  // Newest first; trim from the tail (oldest) when exceeding cap.
  const combined = [ev, ...current];
  const droppedNow = Math.max(0, combined.length - ACTIVITY_LOG_CAP);
  const next = combined.slice(0, ACTIVITY_LOG_CAP);
  const patch: Record<string, unknown> = { [KEY]: next };
  if (droppedNow > 0) {
    const meta = await readMeta();
    patch[META_KEY] = { droppedCount: meta.droppedCount + droppedNow } satisfies ActivityLogMeta;
  }
  await chrome.storage.local.set(patch);
  return ev;
}

export async function getActivity(): Promise<ActivityEvent[]> {
  return await read();
}

/** Eviction accounting: how many entries have ever been dropped, and the window still retained. */
export async function getActivityStats(): Promise<ActivityLogStats> {
  const [entries, meta] = await Promise.all([read(), readMeta()]);
  return {
    droppedCount: meta.droppedCount,
    oldestRetainedTs: entries.length > 0 ? entries[entries.length - 1].ts : null,
    cap: ACTIVITY_LOG_CAP,
  };
}

export async function clearActivity(): Promise<void> {
  // A cleared log starts a fresh window; nothing has been dropped from it yet.
  await chrome.storage.local.set({ [KEY]: [], [META_KEY]: { droppedCount: 0 } });
}

export async function exportActivityJSON(): Promise<Blob> {
  const [entries, meta] = await Promise.all([read(), readMeta()]);
  const payload = {
    cap: ACTIVITY_LOG_CAP,
    droppedCount: meta.droppedCount,
    oldestRetainedTs: entries.length > 0 ? entries[entries.length - 1].ts : null,
    entries,
  };
  return new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
}

/**
 * #452: the one action, if any, that resolves a given activity row.
 *
 * Deliberately narrow. Most of what this file's sources emit has no single
 * action that fixes it - a DOM timing miss on a LinkedIn/Reddit page the
 * operator has likely already left, a refusal that names a person
 * (uncontactable, blocked) rather than a setting, a device revocation that
 * needs a fresh pairing code typed in by hand - and a button pointed at the
 * wrong fix is worse than a row with none. See the PR body for the full
 * message -> action table and what was deliberately left without one.
 */
export type ActivityAction =
  | { kind: 'retry-sync' }
  | { kind: 'open-reddit' }
  | { kind: 'regrant-linkedin-access' }
  | { kind: 'open-backend' }
  | { kind: 'open-assist-settings' };

// Refusal/stop reasons that name a toggle or a cap on the LinkedIn assist
// settings page (web/src/routes/settings/linkedin-assist/+page.svelte),
// rather than something only a person (an unlinked account, a blocklist
// hit) or the network (backend_unreachable) can fix. Shared by both
// surfaces below that can carry one: the in-page assist's own suggestion
// refusal and the passive observation collector's backend 403.
const NAMED_SETTING_REASONS: Record<string, true | undefined> = {
  assist_disabled: true,
  kill_switch: true,
  quota_exhausted: true,
  project_not_bound: true,
  collector_disabled: true,
};

// Sources whose scripts only run at all while the optional LinkedIn host
// permission is granted (background.ts's syncLinkedInContentScripts). A
// warn/error row from one of these, seen while the permission now reads as
// off, is explained by that alone - re-granting is the one fix that
// unblocks everything else these rows could otherwise ask for, so it takes
// priority over the reason-specific mapping below (which cannot fire
// without the permission either).
const LINKEDIN_GATED_SOURCES: Record<ActivitySource, true | undefined> = {
  pairing: undefined,
  'dm-sync': undefined,
  'chat-sync': undefined,
  'matrix-token': undefined,
  'reddit-action': undefined,
  'linkedin-dom': true,
  'linkedin-action': true,
  'linkedin-collector': true,
  settings: undefined,
  system: undefined,
};

export function resolveActivityAction(
  event: Pick<ActivityEvent, 'level' | 'source' | 'message' | 'messageParams'>,
  ctx: { linkedInGranted: boolean },
): ActivityAction | null {
  if (event.level === 'info') return null;

  if (LINKEDIN_GATED_SOURCES[event.source] && !ctx.linkedInGranted) {
    return { kind: 'regrant-linkedin-access' };
  }

  switch (event.message) {
    // The poller that ran this cycle failed outright (background.ts's
    // runAllSyncs) - re-running it now is the same action Dashboard's own
    // "Sync now" button takes.
    case 'activity.dm-sync.error':
    case 'activity.chat-sync.error':
      return { kind: 'retry-sync' };
    // Both messages already tell the operator to open reddit.com (a stale
    // Reddit session for the DM/legacy poller, an expired Matrix token
    // chat-token.ts recaptures the moment reddit.com loads) - the button
    // just takes the action the sentence names.
    case 'activity.dm-sync.unauthorized':
    case 'activity.chat-sync.unauthorized':
      return { kind: 'open-reddit' };
    // A specific draft's backend flip (armed/sent) was refused or
    // unreachable - opening the paired backend is the same single action
    // #201's "Test connection" exists for.
    case 'activity.reddit-action.fail':
    case 'activity.linkedin-action.fail':
      return { kind: 'open-backend' };
    case 'activity.linkedin-action.suggestion-refused': {
      const reason = String(event.messageParams?.reason ?? '');
      if (reason === 'backend_unreachable') return { kind: 'open-backend' };
      if (NAMED_SETTING_REASONS[reason]) return { kind: 'open-assist-settings' };
      // no_account, blocked, uncontactable, recently_contacted,
      // no_recent_activity, selector_health_degraded, generation_failed,
      // extension_reloaded, and anything this client does not recognise:
      // none of these has a single click that resolves it.
      return null;
    }
    case 'activity.linkedin-collector.stopped': {
      const reason = String(event.messageParams?.reason ?? '');
      return NAMED_SETTING_REASONS[reason] ? { kind: 'open-assist-settings' } : null;
    }
    default:
      return null;
  }
}
