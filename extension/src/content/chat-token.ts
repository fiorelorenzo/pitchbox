function tryParse(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const p = JSON.parse(raw);
    return typeof p === 'string' ? p : raw;
  } catch {
    return raw;
  }
}

function readCreds() {
  return {
    matrixUserId: tryParse(localStorage.getItem('chat:matrix-user-id')),
    matrixDeviceId: tryParse(localStorage.getItem('chat:matrix-device-id')),
    matrixToken: tryParse(localStorage.getItem('chat:matrix-access-token')),
  };
}

function send() {
  const c = readCreds();
  if (!c.matrixUserId || !c.matrixToken) return;
  chrome.runtime.sendMessage({ type: 'pitchbox:chat-creds', ...c });
}

send();
window.addEventListener('storage', (e) => {
  if (e.key && /^chat:matrix-/.test(e.key)) send();
});
