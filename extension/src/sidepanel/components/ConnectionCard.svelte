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
    if (!iso) return '—';
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
  <CardHeader><CardTitle>{$t('dashboard.connection.title')}</CardTitle></CardHeader>
  <CardContent class="flex flex-col gap-3">
    {#if pairings.length === 0}
      <p class="text-sm text-muted-foreground">{$t('dashboard.connection.empty')}</p>
      <Button disabled={busy} onclick={pair}>
        {$t('dashboard.connection.pair')}
      </Button>
    {:else}
      {#each pairings as p (p.backendUrl)}
        <div class="flex items-center justify-between gap-2">
          <div class="flex-1 truncate">
            <div class="text-sm font-medium truncate" title={p.backendUrl}>
              {shortHost(p.backendUrl)}
            </div>
            <div class="text-xs text-muted-foreground">
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
      <Button variant="outline" disabled={busy} onclick={pair}>
        {$t('dashboard.connection.pair-another')}
      </Button>
    {/if}
    {#if err}
      <p class="text-xs text-destructive">{err}</p>
    {/if}
  </CardContent>
</Card>
