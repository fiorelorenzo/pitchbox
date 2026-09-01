import { readable, type Readable } from 'svelte/store';
import { browser } from '$app/environment';

export type DaemonModuleStatus = {
  module: string;
  tickAt: string;
  ageSeconds: number;
  alive: boolean;
};

export type DaemonStatus = {
  alive: boolean;
  modules: DaemonModuleStatus[];
  loading: boolean;
  /**
   * False when the last poll could not be read at all (401 after a session
   * lapsed, a 5xx, a dropped connection). `alive: false` then means "we do not
   * know", not "the daemon is down", and a caller must render it as such: a
   * failed poll is not evidence about the daemon.
   */
  reachable: boolean;
};

const initial: DaemonStatus = { alive: false, modules: [], loading: true, reachable: true };

/**
 * Polls the daemon status endpoint. We use a small interval (15s) - the daemon
 * heartbeat cadence is 30s, and the web's staleness threshold is 2 minutes, so
 * 15s polling is sufficient for users to see it flip online/offline quickly.
 */
export const daemonStatus: Readable<DaemonStatus> = readable(initial, (set) => {
  if (!browser) return () => {};

  let cancelled = false;

  async function fetchStatus() {
    try {
      const res = await fetch('/api/daemon/status');
      if (!res.ok) throw new Error(`${res.status}`);
      const body = (await res.json()) as Omit<DaemonStatus, 'loading' | 'reachable'>;
      if (!cancelled) set({ ...body, loading: false, reachable: true });
    } catch {
      if (!cancelled) set({ alive: false, modules: [], loading: false, reachable: false });
    }
  }

  void fetchStatus();
  const timer = setInterval(fetchStatus, 15_000);

  return () => {
    cancelled = true;
    clearInterval(timer);
  };
});
