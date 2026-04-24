import { getSettings, setSettings } from '../lib/storage.js';
import { api } from '../lib/api.js';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

function setStatus(msg: string, kind: 'ok' | 'err') {
  const el = $('status');
  el.textContent = msg;
  el.className = `status ${kind}`;
  el.hidden = false;
}

async function init() {
  const s = await getSettings();
  ($('backendUrl') as HTMLInputElement).value = s.backendUrl ?? '';
  ($('token') as HTMLInputElement).value = s.token ?? '';
  if (s.token && s.lastHandshakeAt) {
    setStatus(`Last connected ${new Date(s.lastHandshakeAt).toLocaleString()}.`, 'ok');
  }
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

init();
