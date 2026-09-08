<!-- Home (#399/#400): the surface that answers "is Pitchbox working, and on
     what" without a click, and puts every control that clears a red state
     one click away.

     It replaced four cards - ConnectionCard, LinkedInAccessCard, SyncCard,
     RedditTokenCard - each of which held a third of the answer and none of
     which was wrong on its own. What survives as its own block is what has
     its own actions; what was only status folded into the state line at the
     top, whose derivation lives in lib/home-state.ts.

     D20 in docs/design/DECISIONS.md: the panel keeps its three tabs, so this
     is a redesign inside one tab, not a new navigation. -->
<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { Card, CardContent } from '$ui/card';
  import { Button } from '$ui/button';
  import { t } from '$ext/i18n';
  import PairingList from '../components/PairingList.svelte';
  import LinkedInAccessRow from '../components/LinkedInAccessRow.svelte';
  import HomeStateLine from '../components/HomeStateLine.svelte';
  import { getSettings, type Pairing } from '$ext/storage';
  import { getLinkedInAccessState } from '$ext/linkedin-access';
  import { homeState } from '$ext/home-state';

  let pairings = $state<Pairing[]>([]);
  let linkedInGranted = $state(false);
  // #401: set by the background worker when Chrome drops a permission we
  // held. Unset is the normal case, including a first run.
  let linkedInRevokedAt = $state<string | undefined>(undefined);

  // Re-derived rather than stored, so no transition can leave the line at
  // the top disagreeing with the blocks under it. Not called `state`: a
  // variable of that name turns every `$state` rune in this file into a
  // store subscription, and the file stops compiling.
  let status = $derived(homeState({ pairings, linkedInGranted, linkedInRevokedAt }));

  // Reddit Chat's token is the one channel whose fix is on another site, so
  // it keeps a control of its own; when it is fine it says nothing at all.
  // `unknown` means never captured, which is every fresh install and not a
  // fault (#341); anything else - `unauthorized` or `error` - is a token
  // that has to be captured again, and saying "no token yet" about a token
  // that broke is the same class of dishonesty this surface exists to fix.
  let chatStatus = $derived(pairings[0]?.syncStatus?.chat);
  let showRedditToken = $derived(pairings.length > 0 && chatStatus !== 'ok');

  let syncBusy = $state(false);
  let syncResult = $state<{ inserted: number; replied: number } | null>(null);
  let nextRunMins = $state<number | null>(null);

  async function refresh() {
    const s = await getSettings();
    pairings = s.pairings;
    linkedInRevokedAt = (await getLinkedInAccessState()).revokedAt;
  }

  async function refreshNextRun() {
    const a = await chrome.alarms.get('pitchbox:dm-sync');
    nextRunMins = a ? Math.max(0, Math.round((a.scheduledTime - Date.now()) / 60000)) : null;
  }

  async function syncNow() {
    syncBusy = true;
    try {
      const reply = await new Promise<{ ok: boolean; inserted?: number; replied?: number }>((res) =>
        chrome.runtime.sendMessage({ type: 'pitchbox:dm-sync:run' }, res),
      );
      if (reply.ok) syncResult = { inserted: reply.inserted ?? 0, replied: reply.replied ?? 0 };
      await refresh();
      await refreshNextRun();
    } finally {
      syncBusy = false;
    }
  }

  // A sync that runs in the background, or a permission dropped from
  // chrome://extensions, has to move this surface with no reload: that is the
  // whole claim it makes.
  const onStorageChanged = (
    changes: Record<string, chrome.storage.StorageChange>,
    area: string,
  ) => {
    if (area !== 'local') return;
    if ('pairings' in changes || 'linkedInAccess' in changes) void refresh();
  };

  onMount(() => {
    refresh();
    refreshNextRun();
    chrome.storage.onChanged.addListener(onStorageChanged);
  });
  onDestroy(() => chrome.storage.onChanged.removeListener(onStorageChanged));
</script>

<div class="flex flex-col gap-4">
  <Card>
    <CardContent class="flex flex-col gap-4">
      <HomeStateLine state={status} />

      <div class="border-t pt-3">
        <PairingList {pairings} onchange={refresh} />
      </div>

      <!-- Sync, LinkedIn access and the Reddit token only mean anything once
           a backend is paired - a suggestion needs somewhere to come from -
           and a first run must offer exactly one working control (#247), so
           all three stay out of the way until then. -->
      {#if pairings.length > 0}
        <div class="flex flex-col gap-2 border-t pt-3">
          <LinkedInAccessRow onchange={(g) => (linkedInGranted = g)} />
        </div>

        <div class="flex flex-col gap-2 border-t pt-3">
          <div class="flex items-center justify-between gap-2">
            <div class="flex min-w-0 flex-col">
              <span class="text-sm font-medium">{$t('dashboard.sync.title')}</span>
              <span class="text-xs text-muted-foreground">
                {nextRunMins !== null
                  ? $t('dashboard.sync.next', { mins: nextRunMins })
                  : $t('home.sync.not-scheduled')}
              </span>
            </div>
            <Button variant="outline" size="sm" disabled={syncBusy} onclick={syncNow}>
              {syncBusy ? $t('dashboard.sync.syncing') : $t('dashboard.sync.now')}
            </Button>
          </div>
          {#if syncResult}
            <p class="text-xs text-muted-foreground">
              {$t('dashboard.sync.counters', syncResult)}
            </p>
          {/if}
        </div>

        {#if showRedditToken}
          <div class="flex items-center justify-between gap-2 border-t pt-3">
            <div class="flex min-w-0 flex-col">
              <span class="text-sm font-medium">{$t('dashboard.token.title')}</span>
              <span class="text-xs text-muted-foreground">
                {chatStatus === 'unknown' || chatStatus === undefined
                  ? $t('dashboard.token.unknown')
                  : $t('dashboard.token.unauthorized')}
              </span>
            </div>
            <Button
              variant="outline"
              size="sm"
              onclick={() => chrome.tabs.create({ url: 'https://www.reddit.com/' })}
            >
              {$t('dashboard.token.open-reddit')}
            </Button>
          </div>
        {/if}
      {/if}
    </CardContent>
  </Card>
</div>
