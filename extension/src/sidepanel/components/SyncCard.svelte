<!-- Sync card: triggers an on-demand DM sync and shows next scheduled run. -->
<script lang="ts">
  import { onMount } from 'svelte';
  import { Card, CardContent, CardHeader, CardTitle } from '$ui/card';
  import { Button } from '$ui/button';
  import { t } from '$ext/i18n';

  let busy = $state(false);
  let result = $state<{ inserted: number; replied: number } | null>(null);
  let nextRunMins = $state<number | null>(null);

  async function refreshNext() {
    const a = await chrome.alarms.get('pitchbox:dm-sync');
    if (!a) {
      nextRunMins = null;
      return;
    }
    nextRunMins = Math.max(0, Math.round((a.scheduledTime - Date.now()) / 60000));
  }
  onMount(refreshNext);

  async function syncNow() {
    busy = true;
    try {
      const reply = await new Promise<{ ok: boolean; inserted?: number; replied?: number }>(
        (res) => chrome.runtime.sendMessage({ type: 'pitchbox:dm-sync:run' }, res),
      );
      if (reply.ok) result = { inserted: reply.inserted ?? 0, replied: reply.replied ?? 0 };
      await refreshNext();
    } finally {
      busy = false;
    }
  }
</script>

<Card>
  <CardHeader><CardTitle>{$t('dashboard.sync.title')}</CardTitle></CardHeader>
  <CardContent class="flex flex-col gap-3">
    {#if result}
      <p class="text-sm">
        {$t('dashboard.sync.counters', result)}
      </p>
    {/if}
    {#if nextRunMins !== null}
      <p class="text-xs text-muted-foreground">
        {$t('dashboard.sync.next', { mins: nextRunMins })}
      </p>
    {/if}
    <Button disabled={busy} onclick={syncNow}>
      {busy ? $t('dashboard.sync.syncing') : $t('dashboard.sync.now')}
    </Button>
  </CardContent>
</Card>
