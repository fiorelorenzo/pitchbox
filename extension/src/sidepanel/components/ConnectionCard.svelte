<!-- Connection card: shows paired backends and lets the user pair or disconnect. -->
<script lang="ts">
  import { onMount } from 'svelte';
  import { Card, CardContent, CardHeader, CardTitle } from '$ui/card';
  import { Button } from '$ui/button';
  import { t } from '$ext/i18n';
  import { getSettings as getStorage, removePairing, type Pairing } from '$ext/storage';

  let pairings = $state<Pairing[]>([]);
  let busy = $state(false);
  let err = $state<string | null>(null);

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
    await removePairing(url);
    await refresh();
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
    {#if err}
      <p class="text-xs text-destructive">{err}</p>
    {/if}
  </CardContent>
</Card>
