<!-- LinkedIn access: on-demand grant of the optional LinkedIn host
     permission (#317). Never declared in host_permissions - requested from
     this card's own button click (a real user gesture, required by Chrome
     for chrome.permissions.request) and reflected from chrome.permissions
     itself rather than assumed, so a revoke made from chrome://extensions
     shows up here too. See lib/permissions.ts and
     docs/linkedin-integration-design.md decision 7. -->
<script lang="ts">
  import { onMount } from 'svelte';
  import { Card, CardContent, CardHeader, CardTitle } from '$ui/card';
  import { Button } from '$ui/button';
  import { t } from '$ext/i18n';
  import {
    hasLinkedInPermission,
    requestLinkedInPermission,
    revokeLinkedInPermission,
  } from '$ext/permissions';

  let granted = $state(false);
  let busy = $state(false);
  // Distinct failure states: the user explicitly declined Chrome's own
  // prompt (first-class, not an error) vs. the request itself throwing
  // (e.g. no longer in a user-gesture context).
  let denied = $state(false);
  let requestFailed = $state(false);

  async function refresh() {
    granted = await hasLinkedInPermission();
  }

  onMount(() => {
    refresh();
    // Keeps this card honest if the permission is revoked from
    // chrome://extensions while the side panel is open, and after a grant
    // made from elsewhere (e.g. a future in-page prompt).
    chrome.permissions.onAdded.addListener(refresh);
    chrome.permissions.onRemoved.addListener(refresh);
    return () => {
      chrome.permissions.onAdded.removeListener(refresh);
      chrome.permissions.onRemoved.removeListener(refresh);
    };
  });

  async function grant() {
    denied = false;
    requestFailed = false;
    busy = true;
    try {
      // Must run in this click's user-gesture context, so request the host
      // permission before any other await resolves.
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
    } finally {
      busy = false;
    }
  }

  async function revoke() {
    busy = true;
    try {
      await revokeLinkedInPermission();
      granted = await hasLinkedInPermission();
    } finally {
      busy = false;
    }
  }
</script>

<Card>
  <CardHeader><CardTitle>{$t('settings.linkedin.title')}</CardTitle></CardHeader>
  <CardContent class="flex flex-col gap-3">
    <p class="text-xs text-muted-foreground">{$t('settings.linkedin.description')}</p>
    <div class="flex items-center justify-between gap-2 text-sm">
      <span
        class="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium {granted
          ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
          : 'border-muted-foreground/30 bg-muted text-muted-foreground'}"
      >
        {granted ? $t('settings.linkedin.granted') : $t('settings.linkedin.not-granted')}
      </span>
      {#if granted}
        <Button variant="outline" disabled={busy} onclick={revoke}>
          {$t('settings.linkedin.revoke')}
        </Button>
      {:else}
        <Button disabled={busy} onclick={grant}>
          {$t('settings.linkedin.grant')}
        </Button>
      {/if}
    </div>
    {#if denied}
      <p class="text-xs text-destructive">{$t('settings.linkedin.denied')}</p>
    {/if}
    {#if requestFailed}
      <p class="text-xs text-destructive">{$t('settings.linkedin.request-failed')}</p>
    {/if}
  </CardContent>
</Card>
