export type Settings = {
  backendUrl: string;
  token: string;
  lastHandshakeAt?: string;
};

const DEFAULTS: Partial<Settings> = { backendUrl: 'http://127.0.0.1:5180' };

export async function getSettings(): Promise<Partial<Settings>> {
  const stored = await chrome.storage.local.get(['backendUrl', 'token', 'lastHandshakeAt']);
  return { ...DEFAULTS, ...stored };
}

export async function setSettings(patch: Partial<Settings>): Promise<void> {
  await chrome.storage.local.set(patch);
}
