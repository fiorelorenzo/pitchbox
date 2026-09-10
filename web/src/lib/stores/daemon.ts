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
  /**
   * False once a poll comes back 403: on cloud this endpoint is
   * instance-admin information (docs/permissions.md "Instance admin"), so a
   * plain member will never pass no matter how many times we ask. `false`
   * here is a permanent-for-the-session fact, not a transient failure, and
   * is the caller's cue to render no daemon state at all rather than an
   * "unavailable" placeholder.
   */
  permitted: boolean;
};

const initial: DaemonStatus = {
  alive: false,
  modules: [],
  loading: true,
  reachable: true,
  permitted: true,
};

/**
 * Polls the daemon status endpoint. We use a small interval (15s) - the daemon
 * heartbeat cadence is 30s, and the web's staleness threshold is 2 minutes, so
 * 15s polling is sufficient for users to see it flip online/offline quickly.
 */
export const daemonStatus: Readable<DaemonStatus> = readable(initial, (set) => {
  if (!browser) return () => {};

  let cancelled = false;
  let pending: number | undefined;

  async function poll() {
    let permitted = true;
    try {
      const res = await fetch('/api/daemon/status');
      if (res.status === 403) {
        // Permanent for this session (see `permitted` above) - stop
        // scheduling further polls instead of asking again every 15s.
        permitted = false;
        if (!cancelled)
          set({ alive: false, modules: [], loading: false, reachable: true, permitted: false });
      } else if (!res.ok) {
        throw new Error(`${res.status}`);
      } else {
        const body = (await res.json()) as Omit<
          DaemonStatus,
          'loading' | 'reachable' | 'permitted'
        >;
        if (!cancelled) set({ ...body, loading: false, reachable: true, permitted: true });
      }
    } catch {
      if (!cancelled)
        set({ alive: false, modules: [], loading: false, reachable: false, permitted: true });
    }
    if (!cancelled && permitted) {
      pending = window.setTimeout(poll, 15_000);
    }
  }

  void poll();

  return () => {
    cancelled = true;
    window.clearTimeout(pending);
  };
});
