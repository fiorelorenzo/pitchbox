<!-- Reddit token card: surfaces Reddit Chat token capture status. -->
<script lang="ts">
  import { onMount } from 'svelte';
  import { Card, CardContent, CardHeader, CardTitle } from '$ui/card';
  import { Button } from '$ui/button';
  import { t } from '$ext/i18n';
  import { getSettings as getStorage } from '$ext/storage';

  let status = $state<'ok' | 'unauthorized' | 'unknown'>('unknown');

  async function refresh() {
    const s = await getStorage();
    const ch = s.pairings[0]?.syncStatus?.chat;
    status = ch === 'ok' ? 'ok' : ch === 'unauthorized' ? 'unauthorized' : 'unknown';
  }
  onMount(refresh);

  function openReddit() {
    chrome.tabs.create({ url: 'https://www.reddit.com/' });
  }
</script>

<Card>
  <CardHeader><CardTitle>{$t('dashboard.token.title')}</CardTitle></CardHeader>
  <CardContent class="flex flex-col gap-3 text-sm">
    {#if status === 'ok'}
      <p>{$t('dashboard.token.ok')}</p>
    {:else if status === 'unauthorized'}
      <p>{$t('dashboard.token.unauthorized')}</p>
      <Button variant="outline" onclick={openReddit}>{$t('dashboard.token.open-reddit')}</Button>
    {:else}
      <p>{$t('dashboard.token.unknown')}</p>
      <Button variant="outline" onclick={openReddit}>{$t('dashboard.token.open-reddit')}</Button>
    {/if}
  </CardContent>
</Card>
