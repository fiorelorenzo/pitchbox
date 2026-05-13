import { describe, it, expect, beforeEach } from 'vitest';

(globalThis as any).chrome = {
  storage: {
    local: {
      _s: {} as Record<string, unknown>,
      async get(keys: string[] | string) {
        const k = Array.isArray(keys) ? keys : [keys];
        const out: Record<string, unknown> = {};
        for (const x of k) if (x in this._s) out[x] = this._s[x];
        return out;
      },
      async set(patch: Record<string, unknown>) {
        Object.assign(this._s, patch);
      },
    },
  },
};

beforeEach(() => {
  ((globalThis as any).chrome.storage.local as any)._s = {};
});

async function load() {
  const mod = await import('../../src/lib/activity.js');
  return mod;
}

describe('activity log', () => {
  it('appends events and persists them', async () => {
    const { logEvent, getActivity } = await load();
    await logEvent({ level: 'info', source: 'system', message: 'system.boot' });
    const all = await getActivity();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ level: 'info', source: 'system', message: 'system.boot' });
    expect(all[0].id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(typeof all[0].ts).toBe('string');
  });

  it('caps the log at ACTIVITY_LOG_CAP entries (newest kept)', async () => {
    const { logEvent, getActivity, ACTIVITY_LOG_CAP } = await load();
    for (let i = 0; i < ACTIVITY_LOG_CAP + 50; i++) {
      await logEvent({ level: 'info', source: 'system', message: `n=${i}` });
    }
    const all = await getActivity();
    expect(all).toHaveLength(ACTIVITY_LOG_CAP);
    expect(all[0].message).toBe(`n=${ACTIVITY_LOG_CAP + 49}`); // newest first
    expect(all[all.length - 1].message).toBe('n=50');
  });

  it('returns events newest first', async () => {
    const { logEvent, getActivity } = await load();
    await logEvent({ level: 'info', source: 'system', message: 'a' });
    await logEvent({ level: 'info', source: 'system', message: 'b' });
    const all = await getActivity();
    expect(all.map((e) => e.message)).toEqual(['b', 'a']);
  });

  it('clearActivity empties the log', async () => {
    const { logEvent, getActivity, clearActivity } = await load();
    await logEvent({ level: 'info', source: 'system', message: 'x' });
    await clearActivity();
    expect(await getActivity()).toEqual([]);
  });

  it('exportActivityJSON returns a JSON blob with the events array', async () => {
    const { logEvent, exportActivityJSON } = await load();
    await logEvent({ level: 'info', source: 'system', message: 'x' });
    const blob = await exportActivityJSON();
    expect(blob.type).toBe('application/json');
    const text = await blob.text();
    const parsed = JSON.parse(text);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].message).toBe('x');
  });
});
