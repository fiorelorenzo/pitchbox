<!-- LinkedIn access as a capability the operator turns on, not a permission
     they grant (D22 in docs/design/DECISIONS.md). Chrome's own bubble already
     carries the permission language, and carries it better than we can; what
     we own is the sentence saying what Pitchbox can do once it is on.

     The state is read back from chrome.permissions rather than from our
     record of having asked, so it can never say on while Chrome says off
     (#317, and the failure that is #401). The request itself stays in this
     component and stays synchronous after the click: chrome.permissions
     .request only works inside a user gesture, so moving it to the
     background worker breaks it silently. -->
<script lang="ts">
  import { onMount } from 'svelte';
  import { Button } from '$ui/button';
  import { t } from '$ext/i18n';
  import {
    hasLinkedInPermission,
    requestLinkedInPermission,
    revokeLinkedInPermission,
  } from '$ext/permissions';

  let { onchange }: { onchange?: (granted: boolean) => void } = $props();

  let granted = $state(false);
  let busy = $state(false);
  // Distinct failure states: the user explicitly declined Chrome's own prompt
  // (first-class, not an error) vs. the request itself throwing (e.g. no
  // longer in a user-gesture context).
  let denied = $state(false);
  let requestFailed = $state(false);

  async function refresh() {
    granted = await hasLinkedInPermission();
    onchange?.(granted);
  }

  onMount(() => {
    refresh();
    // Keeps this row honest if the permission is revoked from
    // chrome://extensions while the panel is open, and after a grant made
    // from elsewhere.
    chrome.permissions.onAdded.addListener(refresh);
    chrome.permissions.onRemoved.addListener(refresh);
    return () => {
      chrome.permissions.onAdded.removeListener(refresh);
      chrome.permissions.onRemoved.removeListener(refresh);
    };
  });

  async function turnOn() {
    denied = false;
    requestFailed = false;
    busy = true;
    try {
      // Must run in this click's user-gesture context, so request before any
      // other await resolves.
      let ok: boolean;
      try {
        ok = await requestLinkedInPermission();
      } catch {
        requestFailed = true;
        return;
      }
      if (!ok) {
        denied = true;
        return;
      }
      granted = true;
      onchange?.(true);
    } finally {
      busy = false;
    }
  }

  async function turnOff() {
    busy = true;
    try {
      await revokeLinkedInPermission();
      await refresh();
    } finally {
      busy = false;
    }
  }
</script>

<div class="flex flex-col gap-2">
  <div class="flex items-center justify-between gap-2">
    <div class="flex min-w-0 flex-col">
      <span class="text-sm font-medium">
        {granted ? $t('home.access.on') : $t('home.access.off')}
      </span>
      <span class="text-xs text-muted-foreground">
        {granted ? $t('home.access.on-detail') : $t('home.access.off-detail')}
      </span>
    </div>
    {#if granted}
      <Button variant="ghost" size="sm" disabled={busy} onclick={turnOff}>
        {$t('home.access.turn-off')}
      </Button>
    {:else}
      <Button size="sm" disabled={busy} onclick={turnOn}>
        {$t('home.access.turn-on')}
      </Button>
    {/if}
  </div>
  {#if denied}
    <p class="text-xs text-destructive">{$t('home.access.denied')}</p>
  {/if}
  {#if requestFailed}
    <p class="text-xs text-destructive">{$t('home.access.request-failed')}</p>
  {/if}
</div>
