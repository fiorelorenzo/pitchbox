import { getSettings, setSettings } from '../lib/storage.js';
import { api } from '../lib/api.js';

const $ = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;

function setStatus(msg: string, kind: 'ok' | 'err') {
  const el = $('status');
  el.textContent = msg;
  el.className = `status ${kind}`;
  el.hidden = false;
}

function fmtAgo(iso?: string | null): string {
  if (!iso) return 'never';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

async function refreshSyncLabel() {
  const { lastDmSyncAt } = await getSettings();
  $('syncLabel').textContent = `DM sync: ${fmtAgo(lastDmSyncAt)}`;
}

async function init() {
  const s = await getSettings();
  ($('backendUrl') as HTMLInputElement).value = s.backendUrl ?? '';
  ($('token') as HTMLInputElement).value = s.token ?? '';
  if (s.token && s.lastHandshakeAt) {
    setStatus(`Last connected ${new Date(s.lastHandshakeAt).toLocaleString()}.`, 'ok');
  }
  await refreshSyncLabel();
}

$<HTMLButtonElement>('connect').addEventListener('click', async () => {
  const backendUrl = ($('backendUrl') as HTMLInputElement).value.trim().replace(/\/$/, '');
  const token = ($('token') as HTMLInputElement).value.trim();
  if (!backendUrl || !token) {
    setStatus('Both fields required.', 'err');
    return;
  }
  await setSettings({ backendUrl, token });
  const r = await api.handshake();
  if (r.ok) {
    await setSettings({ lastHandshakeAt: new Date().toISOString() });
    setStatus(`Connected — dashboard v${r.data.version}.`, 'ok');
  } else {
    setStatus(`Failed (${r.status}): ${r.error || 'no response'}`, 'err');
  }
});

$<HTMLButtonElement>('syncNow').addEventListener('click', async () => {
  $('syncLabel').textContent = 'DM sync: running…';
  const reply = await new Promise<{
    ok: boolean;
    inserted?: number;
    replied?: number;
    reason?: string;
  }>((resolve) => chrome.runtime.sendMessage({ type: 'pitchbox:dm-sync:run' }, resolve));
  if (!reply.ok) {
    setStatus(`Sync failed: ${reply.reason ?? 'unknown'}`, 'err');
  } else {
    setStatus(`Sync OK — ${reply.inserted ?? 0} new, ${reply.replied ?? 0} replied.`, 'ok');
  }
  await refreshSyncLabel();
});

init();
