<!-- Connection card: shows paired backends and lets the user pair or disconnect. -->
<script lang="ts">
  import { onMount } from 'svelte';
  import { Card, CardContent, CardHeader, CardTitle } from '$ui/card';
  import { Button } from '$ui/button';
  import { Input } from '$ui/input';
  import { t } from '$ext/i18n';
  import { api } from '$ext/api';
  import { getSettings as getStorage, removePairing, upsertPairing, type Pairing } from '$ext/storage';
  import { DEFAULT_BACKEND_URL, normalizeBackendUrl } from '$ext/backend';
  import { originStillNeeded } from '$ext/permissions';

  let pairings = $state<Pairing[]>([]);
  let busy = $state(false);
  let err = $state<string | null>(null);

  // "Add with a pairing code" form: connects to any backend without needing
  // its dashboard open in a tab (the code is the one-time secret).
  let showAdd = $state(false);
  let formUrl = $state(DEFAULT_BACKEND_URL);
  let formCode = $state('');
  let addBusy = $state(false);

  async function refresh() {
    const s = await getStorage();
    pairings = s.pairings;
  }
  onMount(refresh);

  function shortHost(url: string) {
    try {
      return new URL(url).host;
    } catch {
      return url;
    }
  }
  function fmtAgo(iso: string | undefined) {
    if (!iso) return '-';
    const ms = Date.now() - new Date(iso).getTime();
    if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
    if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
    if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h`;
    return `${Math.floor(ms / 86_400_000)}d`;
  }

  async function pair() {
    busy = true;
    err = null;
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id || !tab.url) {
        err = 'No active tab';
        return;
      }
      const origin = new URL(tab.url).origin;
      const granted = await chrome.permissions.request({ origins: [origin + '/*'] });
      if (!granted) {
        err = 'Permission denied';
        return;
      }
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['src/content/auto-pair.ts'],
      });
      await new Promise((r) => setTimeout(r, 700));
      await refresh();
    } finally {
      busy = false;
    }
  }

  async function disconnect(url: string) {
    const remaining = await removePairing(url);
    // Best-effort: also drop the standing host permission granted when this
    // backend was paired (see pair()/connectWithCode()), but only if no other
    // remaining pairing still targets the same origin. Revoking an origin
    // that overlaps a required host permission (reddit.com, pitchbox.app,
    // localhost) is a documented no-op, not an error, but guard anyway since
    // this must never block disconnecting.
    try {
      const origin = new URL(url).origin;
      if (!originStillNeeded(remaining, origin)) {
        await chrome.permissions.remove({ origins: [origin + '/*'] });
      }
    } catch {
      // Ignore: worst case the extension keeps an unused host permission.
    }
    await refresh();
  }

  async function connectWithCode() {
    addBusy = true;
    err = null;
    try {
      const url = normalizeBackendUrl(formUrl);
      if (!url) {
        err = $t('dashboard.connection.bad-url');
        return;
      }
      const code = formCode.trim();
      if (!code) {
        err = $t('dashboard.connection.code-required');
        return;
      }
      // Must run in this click's user-gesture context, so request the host
      // permission before any other await resolves.
      const granted = await chrome.permissions.request({ origins: [url + '/*'] });
      if (!granted) {
        err = $t('dashboard.connection.perm-denied', { host: new URL(url).host });
        return;
      }
      const res = await api.pairWithCode(url, code);
      if (!res.ok) {
        err = $t('dashboard.connection.pair-failed', { reason: res.error || String(res.status) });
        return;
      }
      await upsertPairing({
        backendUrl: url,
        token: res.data.token,
        lastHandshakeAt: new Date().toISOString(),
      });
      formCode = '';
      showAdd = false;
      await refresh();
    } finally {
      addBusy = false;
    }
  }
</script>

<Card>
  <CardHeader class="flex flex-row items-center justify-between gap-2 space-y-0">
    <CardTitle>{$t('dashboard.connection.title')}</CardTitle>
    <span
      class="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium {pairings.length >
      0
        ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
        : 'border-muted-foreground/30 bg-muted text-muted-foreground'}"
    >
      <span
        class="size-1.5 rounded-full {pairings.length > 0
          ? 'bg-emerald-500'
          : 'bg-muted-foreground/60'}"
      ></span>
      {pairings.length > 0
        ? $t('dashboard.connection.connected')
        : $t('dashboard.connection.disconnected')}
    </span>
  </CardHeader>
  <CardContent class="flex flex-col gap-3">
    {#if pairings.length === 0}
      <p class="text-sm text-muted-foreground">{$t('dashboard.connection.empty')}</p>
      <p class="text-xs text-muted-foreground">
        {$t('dashboard.connection.default-hint', { url: shortHost(DEFAULT_BACKEND_URL) })}
      </p>
      <Button disabled={busy} onclick={pair}>
        {$t('dashboard.connection.pair')}
      </Button>
    {:else}
      <div class="flex flex-col divide-y divide-border rounded-md border bg-muted/30">
        {#each pairings as p (p.backendUrl)}
          <div class="flex items-center justify-between gap-2 px-3 py-2.5">
            <div class="flex min-w-0 flex-1 flex-col gap-0.5">
              <div class="flex items-center gap-2">
                <span
                  class="size-2 shrink-0 rounded-full bg-emerald-500"
                  aria-hidden="true"
                ></span>
                <span class="truncate text-sm font-medium" title={p.backendUrl}>
                  {shortHost(p.backendUrl)}
                </span>
              </div>
              <div class="pl-4 text-xs text-muted-foreground">
                {$t('dashboard.connection.handshake-ago', { ago: fmtAgo(p.lastHandshakeAt) })}
                ·
                {$t('dashboard.connection.sync-ago', { ago: fmtAgo(p.lastDmSyncAt) })}
              </div>
            </div>
            <Button variant="ghost" size="sm" onclick={() => disconnect(p.backendUrl)}>
              {$t('dashboard.connection.disconnect')}
            </Button>
          </div>
        {/each}
      </div>
      <Button variant="outline" disabled={busy} onclick={pair}>
        {$t('dashboard.connection.pair-another')}
      </Button>
    {/if}
    <div class="flex flex-col gap-2 border-t pt-3">
      {#if !showAdd}
        <Button variant="ghost" size="sm" class="self-start" onclick={() => (showAdd = true)}>
          {$t('dashboard.connection.add-toggle')}
        </Button>
      {:else}
        <p class="text-xs text-muted-foreground">{$t('dashboard.connection.add-hint')}</p>
        <Input bind:value={formUrl} placeholder={$t('dashboard.connection.backend-placeholder')} />
        <Input bind:value={formCode} placeholder={$t('dashboard.connection.code-placeholder')} />
        <div class="flex gap-2">
          <Button disabled={addBusy} onclick={connectWithCode}>
            {addBusy ? $t('dashboard.connection.connecting') : $t('dashboard.connection.connect')}
          </Button>
          <Button variant="ghost" disabled={addBusy} onclick={() => (showAdd = false)}>
            {$t('dashboard.connection.cancel')}
          </Button>
        </div>
      {/if}
    </div>
    {#if err}
      <p class="text-xs text-destructive">{err}</p>
    {/if}
  </CardContent>
</Card>
