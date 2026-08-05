<!-- Dashboard route: composes the connection, sync, and Reddit token cards.
     Sync and the Reddit token status only mean anything once at least one
     backend is paired, so both stay hidden until then - a first run should
     offer exactly one working control (#247). -->
<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import ConnectionCard from '../components/ConnectionCard.svelte';
  import SyncCard from '../components/SyncCard.svelte';
  import RedditTokenCard from '../components/RedditTokenCard.svelte';
  import { getSettings, type Pairing } from '$ext/storage';

  let paired = $state(false);

  async function refresh() {
    const s = await getSettings();
    paired = s.pairings.length > 0;
  }

  const handler = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area === 'local' && changes.pairings) {
      paired = ((changes.pairings.newValue as Pairing[] | undefined) ?? []).length > 0;
    }
  };

  onMount(() => {
    refresh();
    chrome.storage.onChanged.addListener(handler);
  });
  onDestroy(() => chrome.storage.onChanged.removeListener(handler));
</script>

<div class="flex flex-col gap-4">
  <ConnectionCard />
  {#if paired}
    <SyncCard />
    <RedditTokenCard />
  {/if}
</div>
