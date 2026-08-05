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

  it('exportActivityJSON returns a JSON blob with entries plus eviction facts', async () => {
    const { logEvent, exportActivityJSON, ACTIVITY_LOG_CAP } = await load();
    await logEvent({ level: 'info', source: 'system', message: 'x' });
    const blob = await exportActivityJSON();
    expect(blob.type).toBe('application/json');
    const text = await blob.text();
    const parsed = JSON.parse(text);
    expect(Array.isArray(parsed)).toBe(false);
    expect(parsed.cap).toBe(ACTIVITY_LOG_CAP);
    expect(parsed.droppedCount).toBe(0);
    expect(parsed.oldestRetainedTs).toBe(parsed.entries[0].ts);
    expect(Array.isArray(parsed.entries)).toBe(true);
    expect(parsed.entries[0].message).toBe('x');
  });

  describe('eviction accounting', () => {
    it('reports no drops and no misleading claim of loss below the cap', async () => {
      const { logEvent, getActivity, getActivityStats, exportActivityJSON, ACTIVITY_LOG_CAP } =
        await load();
      for (let i = 0; i < ACTIVITY_LOG_CAP - 10; i++) {
        await logEvent({ level: 'info', source: 'system', message: `n=${i}` });
      }
      const all = await getActivity();
      const stats = await getActivityStats();
      expect(stats.droppedCount).toBe(0);
      expect(stats.cap).toBe(ACTIVITY_LOG_CAP);
      expect(stats.oldestRetainedTs).toBe(all[all.length - 1].ts);

      const parsed = JSON.parse(await (await exportActivityJSON()).text());
      expect(parsed.droppedCount).toBe(0);
    });

    it('reports no eviction when sitting exactly at the cap', async () => {
      const { logEvent, getActivity, getActivityStats, ACTIVITY_LOG_CAP } = await load();
      for (let i = 0; i < ACTIVITY_LOG_CAP; i++) {
        await logEvent({ level: 'info', source: 'system', message: `n=${i}` });
      }
      const all = await getActivity();
      expect(all).toHaveLength(ACTIVITY_LOG_CAP);
      const stats = await getActivityStats();
      expect(stats.droppedCount).toBe(0);
    });

    it('counts every eviction once the log is pushed past the cap', async () => {
      const { logEvent, getActivity, getActivityStats, exportActivityJSON, ACTIVITY_LOG_CAP } =
        await load();
      const overflow = 37;
      for (let i = 0; i < ACTIVITY_LOG_CAP + overflow; i++) {
        await logEvent({ level: 'info', source: 'system', message: `n=${i}` });
      }
      const all = await getActivity();
      const stats = await getActivityStats();
      expect(stats.droppedCount).toBe(overflow);
      expect(stats.oldestRetainedTs).toBe(all[all.length - 1].ts);

      const parsed = JSON.parse(await (await exportActivityJSON()).text());
      expect(parsed.droppedCount).toBe(overflow);
      expect(parsed.oldestRetainedTs).toBe(stats.oldestRetainedTs);
      expect(parsed.entries).toHaveLength(ACTIVITY_LOG_CAP);
    });

    it('keeps the dropped count monotonic across separate overflow bursts', async () => {
      const { logEvent, getActivityStats, ACTIVITY_LOG_CAP } = await load();
      for (let i = 0; i < ACTIVITY_LOG_CAP + 10; i++) {
        await logEvent({ level: 'info', source: 'system', message: `a${i}` });
      }
      expect((await getActivityStats()).droppedCount).toBe(10);
      for (let i = 0; i < 5; i++) {
        await logEvent({ level: 'info', source: 'system', message: `b${i}` });
      }
      expect((await getActivityStats()).droppedCount).toBe(15);
    });

    it('survives a reload: dropped count is read back from persisted storage', async () => {
      const { logEvent, ACTIVITY_LOG_CAP } = await load();
      for (let i = 0; i < ACTIVITY_LOG_CAP + 3; i++) {
        await logEvent({ level: 'info', source: 'system', message: `n=${i}` });
      }
      // Simulate a fresh panel/service-worker load: a brand new call reading
      // only from chrome.storage.local, with no in-memory state carried over.
      const { getActivityStats } = await load();
      expect((await getActivityStats()).droppedCount).toBe(3);
    });

    it('clearActivity resets the dropped count along with the entries', async () => {
      const { logEvent, clearActivity, getActivityStats, ACTIVITY_LOG_CAP } = await load();
      for (let i = 0; i < ACTIVITY_LOG_CAP + 8; i++) {
        await logEvent({ level: 'info', source: 'system', message: `n=${i}` });
      }
      expect((await getActivityStats()).droppedCount).toBe(8);
      await clearActivity();
      const stats = await getActivityStats();
      expect(stats.droppedCount).toBe(0);
      expect(stats.oldestRetainedTs).toBeNull();
    });
  });
});
