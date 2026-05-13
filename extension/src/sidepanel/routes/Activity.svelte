<!-- Activity route: live-filtered list with export + clear actions. -->
<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { Button } from '$ui/button';
  import * as AlertDialog from '$ui/alert-dialog';
  import ActivityFilters from '../components/ActivityFilters.svelte';
  import ActivityRow from '../components/ActivityRow.svelte';
  import {
    getActivity,
    clearActivity,
    exportActivityJSON,
    type ActivityEvent,
    type ActivityLevel,
    type ActivitySource,
  } from '$ext/activity';
  import { t } from '$ext/i18n';

  let events = $state<ActivityEvent[]>([]);
  let search = $state('');
  let level = $state<ActivityLevel | 'all'>('all');
  let source = $state<ActivitySource | 'all'>('all');
  let confirmOpen = $state(false);

  const handler = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area === 'local' && changes.activityLog) {
      events = (changes.activityLog.newValue as ActivityEvent[]) ?? [];
    }
  };

  onMount(async () => {
    events = await getActivity();
    chrome.storage.onChanged.addListener(handler);
  });
  onDestroy(() => chrome.storage.onChanged.removeListener(handler));

  let filtered = $derived(
    events.filter((e) => {
      if (level !== 'all' && e.level !== level) return false;
      if (source !== 'all' && e.source !== source) return false;
      if (search) {
        const hay =
          `${e.message} ${JSON.stringify(e.messageParams ?? {})} ${JSON.stringify(e.meta ?? {})}`.toLowerCase();
        if (!hay.includes(search.toLowerCase())) return false;
      }
      return true;
    }),
  );

  async function doExport() {
    const blob = await exportActivityJSON();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `pitchbox-activity-${new Date().toISOString()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function doClear() {
    await clearActivity();
    confirmOpen = false;
  }
</script>

<div class="flex flex-col gap-4">
  <ActivityFilters bind:search bind:level bind:source />

  <div class="flex gap-2">
    <Button variant="outline" size="sm" onclick={doExport}>
      {$t('activity.actions.export')}
    </Button>
    <Button variant="ghost" size="sm" onclick={() => (confirmOpen = true)}>
      {$t('activity.actions.clear')}
    </Button>
  </div>

  <AlertDialog.Root bind:open={confirmOpen}>
    <AlertDialog.Content>
      <AlertDialog.Header>
        <AlertDialog.Title>{$t('activity.clear.confirm-title')}</AlertDialog.Title>
        <AlertDialog.Description>{$t('activity.clear.confirm-body')}</AlertDialog.Description>
      </AlertDialog.Header>
      <AlertDialog.Footer>
        <AlertDialog.Cancel onclick={() => (confirmOpen = false)}>
          {$t('activity.clear.cancel')}
        </AlertDialog.Cancel>
        <AlertDialog.Action onclick={doClear}>
          {$t('activity.clear.confirm-ok')}
        </AlertDialog.Action>
      </AlertDialog.Footer>
    </AlertDialog.Content>
  </AlertDialog.Root>

  {#if filtered.length === 0}
    <p class="text-sm text-muted-foreground">{$t('activity.empty')}</p>
  {:else}
    <div class="flex flex-col">
      {#each filtered as e (e.id)}
        <ActivityRow event={e} />
      {/each}
    </div>
  {/if}
</div>
