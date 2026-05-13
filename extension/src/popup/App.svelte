<script lang="ts">
  import { onMount } from 'svelte';
  import { getSettings, removePairing, type Pairing } from '../lib/storage.js';

  type Status = { kind: 'idle' | 'ok' | 'err'; msg?: string };

  let pairings = $state<Pairing[]>([]);
  let chatSyncStatus = $state<'ok' | 'unauthorized' | 'error' | 'unknown' | null>(null);
  let status = $state<Status>({ kind: 'idle' });
  let busy = $state(false);
  let syncing = $state(false);

  async function refresh() {
    const s = await getSettings();
    pairings = s.pairings;
    chatSyncStatus = s.pairings[0]?.syncStatus?.chat ?? null;
  }

  onMount(refresh);

  function openReddit() {
    try {
      chrome.tabs?.create?.({ url: 'https://www.reddit.com/' });
    } catch {
      // tabs API may be unavailable
    }
  }

  function fmtAgo(iso: string | undefined): string {
    if (!iso) return 'never';
    const ms = Date.now() - new Date(iso).getTime();
    if (ms < 60_000) return `${Math.floor(ms / 1000)}s ago`;
    if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
    if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
    return `${Math.floor(ms / 86_400_000)}d ago`;
  }

  function shortHost(url: string): string {
    try {
      return new URL(url).host;
    } catch {
      return url;
    }
  }

  async function pairWithThisTab() {
    busy = true;
    status = { kind: 'idle' };
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id || !tab.url) {
        status = { kind: 'err', msg: 'No active tab.' };
        return;
      }
      let origin: string;
      try {
        origin = new URL(tab.url).origin;
      } catch {
        status = { kind: 'err', msg: 'Active tab has no valid URL.' };
        return;
      }
      if (tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) {
        status = { kind: 'err', msg: 'Open your Pitchbox dashboard in this tab first.' };
        return;
      }
      const granted = await chrome.permissions.request({ origins: [origin + '/*'] });
      if (!granted) {
        status = { kind: 'err', msg: 'Permission denied for this site.' };
        return;
      }
      // Inject the auto-pair script into the granted tab. The script reads
      // the dashboard's session cookie (same-origin), calls /api/extension/
      // auto-pair, and posts the resulting token to the background, which
      // persists it via upsertPairing.
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['src/content/auto-pair.ts'],
      });
      // Wait briefly for the background to receive and persist the token.
      await new Promise((r) => setTimeout(r, 700));
      const before = pairings.length;
      await refresh();
      const matched = pairings.find((p) => p.backendUrl === origin);
      if (matched) {
        status = { kind: 'ok', msg: `Paired with ${shortHost(matched.backendUrl)}.` };
      } else if (pairings.length > before) {
        status = { kind: 'ok', msg: 'Paired.' };
      } else {
        status = {
          kind: 'err',
          msg: 'Pairing failed — make sure you are signed in to the dashboard in this tab.',
        };
      }
    } finally {
      busy = false;
    }
  }

  async function disconnect(backendUrl: string) {
    await removePairing(backendUrl);
    await refresh();
  }

  async function syncNow() {
    syncing = true;
    try {
      const reply = await new Promise<{
        ok: boolean;
        inserted?: number;
        replied?: number;
        reason?: string;
      }>((resolve) => chrome.runtime.sendMessage({ type: 'pitchbox:dm-sync:run' }, resolve));
      if (!reply.ok) {
        status = { kind: 'err', msg: `Sync failed: ${reply.reason ?? 'unknown'}` };
      } else {
        status = {
          kind: 'ok',
          msg: `Sync OK — ${reply.inserted ?? 0} new, ${reply.replied ?? 0} replied.`,
        };
      }
      await refresh();
    } finally {
      syncing = false;
    }
  }
</script>

<main class="flex flex-col gap-3 p-4">
  <header class="flex items-center gap-2 pb-2 border-b border-[var(--color-border)]">
    <svg viewBox="0 0 512 512" class="size-7 shrink-0" aria-hidden="true">
      <rect x="16" y="16" width="480" height="480" rx="112" fill="#0b1220" />
      <path
        d="M124 332 L124 200 L256 132 L388 200 L388 332 Z"
        fill="none"
        stroke="#38bdf8"
        stroke-width="28"
        stroke-linejoin="round"
      />
      <path d="M256 132 L256 240" stroke="#38bdf8" stroke-width="28" stroke-linecap="round" />
      <path
        d="M178 280 L256 202 L334 280"
        fill="none"
        stroke="#f8fafc"
        stroke-width="36"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
    <h1 class="text-sm font-semibold flex-1">Pitchbox</h1>
  </header>

  {#if pairings.length === 0}
    <button
      disabled={busy}
      onclick={pairWithThisTab}
      class="rounded-md bg-[var(--color-accent)] text-[var(--color-bg)] font-medium py-2 disabled:opacity-60 hover:brightness-110 text-[13px]"
    >
      {busy ? 'Pairing…' : 'Pair with this tab'}
    </button>
    <p class="text-[11px] text-[var(--color-muted)] -mt-1">
      Open your Pitchbox dashboard in the active tab and click above. Granted access stays scoped
      to that origin. You can pair multiple backends (e.g. cloud + self-hosted) — every Reddit
      reply syncs to all of them.
    </p>
  {:else}
    <div class="flex flex-col gap-2">
      {#each pairings as p (p.backendUrl)}
        <div class="rounded-md bg-[var(--color-bg-elev)] px-3 py-2">
          <div class="flex items-center gap-2">
            <span class="text-[12px] font-medium text-[var(--color-fg)] flex-1 truncate" title={p.backendUrl}>
              {shortHost(p.backendUrl)}
            </span>
            <button
              type="button"
              class="text-[10px] text-[var(--color-muted)] hover:text-[var(--color-fg)] underline-offset-2 hover:underline"
              onclick={() => disconnect(p.backendUrl)}
            >
              Disconnect
            </button>
          </div>
          <div class="text-[10.5px] text-[var(--color-muted)] mt-0.5">
            handshake {fmtAgo(p.lastHandshakeAt)} · sync {fmtAgo(p.lastDmSyncAt)}
          </div>
        </div>
      {/each}
    </div>

    <button
      disabled={busy}
      onclick={pairWithThisTab}
      class="rounded-md border border-[var(--color-border)] py-1.5 text-[12px] text-[var(--color-fg)] hover:bg-[var(--color-bg-elev)] disabled:opacity-60"
    >
      {busy ? 'Pairing…' : 'Pair with another tab'}
    </button>

    <button
      disabled={syncing}
      onclick={syncNow}
      class="rounded-md bg-[var(--color-accent)] text-[var(--color-bg)] font-medium py-1.5 disabled:opacity-60 hover:brightness-110"
    >
      {syncing ? 'Syncing…' : 'Sync now'}
    </button>

    {#if chatSyncStatus === 'unauthorized'}
      <div class="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-300">
        <div class="font-medium text-amber-200">Reddit Chat sync paused</div>
        <div class="mt-0.5">
          Please open reddit.com and refresh so the extension can capture a fresh Matrix token.
        </div>
        <button
          onclick={openReddit}
          class="mt-1.5 rounded-md bg-amber-500/20 hover:bg-amber-500/30 px-2 py-1 text-[11px] font-medium text-amber-100"
        >
          Open reddit.com
        </button>
      </div>
    {/if}
  {/if}

  {#if status.kind !== 'idle' && status.msg}
    <div
      class="rounded-md px-3 py-2 text-[11px] {status.kind === 'ok'
        ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30'
        : 'bg-rose-500/15 text-rose-200 border border-rose-500/30'}"
    >
      {status.msg}
    </div>
  {/if}
</main>
