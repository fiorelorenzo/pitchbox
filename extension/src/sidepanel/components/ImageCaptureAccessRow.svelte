<!-- Image-aware suggestions as their own opt-in (#569), deliberately not
     folded into LinkedInAccessRow above (Main's call, 2026-09-09): the
     button that turns the assistant on at all must keep asking Chrome's
     narrowest possible question, so declining the image feature never reads
     as declining the assistant itself. `chrome.tabs.captureVisibleTab` is a
     browser-level capture of the visible tab, so Chrome will not scope its
     permission check to one origin the way it does for reading the page -
     turning this on means answering Chrome's own "all sites" prompt, not a
     LinkedIn-only one, and the copy below says so before the click rather
     than leaving it to Chrome's bubble to explain.

     Same posture as LinkedInAccessRow otherwise: state read back from
     chrome.permissions rather than a local record of having asked, and the
     request stays synchronous after the click for the same user-gesture
     reason. -->
<script lang="ts">
  import { onMount } from 'svelte';
  import { Button } from '$ui/button';
  import { t } from '$ext/i18n';
  import {
    hasImageCapturePermission,
    requestImageCapturePermission,
    revokeImageCapturePermission,
  } from '$ext/permissions';

  let granted = $state(false);
  let busy = $state(false);
  let denied = $state(false);
  let requestFailed = $state(false);

  async function refresh() {
    granted = await hasImageCapturePermission();
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
        ok = await requestImageCapturePermission();
      } catch {
        requestFailed = true;
        return;
      }
      if (!ok) {
        denied = true;
        return;
      }
      granted = true;
    } finally {
      busy = false;
    }
  }

  async function turnOff() {
    busy = true;
    try {
      await revokeImageCapturePermission();
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
        {granted ? $t('home.image-access.on') : $t('home.image-access.off')}
      </span>
      <span class="text-xs text-muted-foreground">
        {granted ? $t('home.image-access.on-detail') : $t('home.image-access.off-detail')}
      </span>
    </div>
    {#if granted}
      <Button variant="ghost" size="sm" disabled={busy} onclick={turnOff}>
        {$t('home.image-access.turn-off')}
      </Button>
    {:else}
      <Button size="sm" disabled={busy} onclick={turnOn}>
        {$t('home.image-access.turn-on')}
      </Button>
    {/if}
  </div>
  {#if denied}
    <p class="text-xs text-destructive">{$t('home.image-access.denied')}</p>
  {/if}
  {#if requestFailed}
    <p class="text-xs text-destructive">{$t('home.image-access.request-failed')}</p>
  {/if}
</div>
