export type ThemeMode = 'light' | 'dark' | 'system';
export type Density = 'compact' | 'comfortable';
export type LocaleCode = 'en' | 'it';
export type SyncIntervalMin = 5 | 10 | 15 | 30;

export type ExtensionSettings = {
  theme: ThemeMode;
  density: Density;
  locale: LocaleCode;
  syncIntervalMin: SyncIntervalMin;
  legacyPollerEnabled: boolean;
  chatPollerEnabled: boolean;
};

export const DEFAULTS: ExtensionSettings = {
  theme: 'system',
  density: 'comfortable',
  locale: 'en',
  syncIntervalMin: 10,
  legacyPollerEnabled: true,
  chatPollerEnabled: true,
};

const KEY = 'extensionSettings';
const VALID_INTERVALS: ReadonlyArray<SyncIntervalMin> = [5, 10, 15, 30];

function sanitize(patch: Partial<ExtensionSettings>, prior: ExtensionSettings): ExtensionSettings {
  const next: ExtensionSettings = { ...prior };
  if (patch.theme === 'light' || patch.theme === 'dark' || patch.theme === 'system')
    next.theme = patch.theme;
  if (patch.density === 'compact' || patch.density === 'comfortable')
    next.density = patch.density;
  if (patch.locale === 'en' || patch.locale === 'it') next.locale = patch.locale;
  if (
    typeof patch.syncIntervalMin === 'number' &&
    VALID_INTERVALS.includes(patch.syncIntervalMin as SyncIntervalMin)
  )
    next.syncIntervalMin = patch.syncIntervalMin as SyncIntervalMin;
  if (typeof patch.legacyPollerEnabled === 'boolean')
    next.legacyPollerEnabled = patch.legacyPollerEnabled;
  if (typeof patch.chatPollerEnabled === 'boolean')
    next.chatPollerEnabled = patch.chatPollerEnabled;
  return next;
}

export async function getSettings(): Promise<ExtensionSettings> {
  const out = (await chrome.storage.local.get(KEY)) as {
    extensionSettings?: Partial<ExtensionSettings>;
  };
  return sanitize(out.extensionSettings ?? {}, DEFAULTS);
}

export async function setSettings(
  patch: Partial<ExtensionSettings>,
): Promise<ExtensionSettings> {
  const prior = await getSettings();
  const next = sanitize(patch, prior);
  await chrome.storage.local.set({ [KEY]: next });
  return next;
}
