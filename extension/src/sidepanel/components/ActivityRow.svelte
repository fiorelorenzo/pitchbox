<!-- Single row in the Activity tab list. #452: an error/warn row that has
     exactly one action that resolves it (resolveActivityAction, lib/activity.ts)
     offers it here - reusing the same storage/permission helpers home
     already uses, never a second copy of that logic. -->
<script lang="ts">
  import { t } from '$ext/i18n';
  import { Badge } from '$ui/badge';
  import { Button } from '$ui/button';
  import { resolveActivityAction, type ActivityAction, type ActivityEvent } from '$ext/activity';
  import { requestLinkedInPermission } from '$ext/permissions';
  import { getSettings } from '$ext/storage';

  let {
    event,
    // Read back from chrome.permissions by the Activity route (same source
    // #401's home state reads), and passed down rather than re-read per row.
    // Defaults on so a caller that does not track it yet (existing tests)
    // never has a LinkedIn row's action silently swallowed.
    linkedInGranted = true,
  }: { event: ActivityEvent; linkedInGranted?: boolean } = $props();

  const levelVariant = {
    info: 'secondary',
    warn: 'outline',
    error: 'destructive',
  } as const;

  const ACTION_LABEL_KEY: Record<ActivityAction['kind'], string> = {
    'retry-sync': 'activity.actions.retry-sync',
    // No entry of its own - reuses the exact button Dashboard already ships
    // for the same fix (dashboard.token.open-reddit).
    'open-reddit': 'dashboard.token.open-reddit',
    'regrant-linkedin-access': 'activity.actions.regrant-linkedin',
    'open-backend': 'activity.actions.open-backend',
    'open-assist-settings': 'activity.actions.open-assist-settings',
  };

  const action = $derived(resolveActivityAction(event, { linkedInGranted }));

  let busy = $state(false);
  // LinkedInAccessRow.svelte's own distinct case: the user explicitly
  // declined Chrome's permission prompt, not an error.
  let denied = $state(false);

  async function runAction() {
    const a = action;
    if (!a) return;
    denied = false;
    busy = true;
    try {
      if (a.kind === 'regrant-linkedin-access') {
        // Must be the first await in this branch: chrome.permissions.request
        // only works inside this click's user-gesture context, same rule as
        // LinkedInAccessRow.svelte's own turnOn().
        let ok = false;
        try {
          ok = await requestLinkedInPermission();
        } catch {
          ok = false;
        }
        if (!ok) denied = true;
        return;
      }
      if (a.kind === 'retry-sync') {
        await new Promise<void>((resolve) =>
          chrome.runtime.sendMessage({ type: 'pitchbox:dm-sync:run' }, () => resolve()),
        );
        return;
      }
      if (a.kind === 'open-reddit') {
        chrome.tabs.create({ url: 'https://www.reddit.com/' });
        return;
      }
      // open-backend / open-assist-settings: both point at the paired
      // backend (pickPairing's own single-backend default, api.ts) - no
      // per-event backendUrl exists to disambiguate among several.
      const { pairings } = await getSettings();
      const backend = pairings[0];
      if (!backend) return;
      const path = a.kind === 'open-assist-settings' ? '/settings/linkedin-assist' : '';
      chrome.tabs.create({ url: backend.backendUrl + path });
    } finally {
      busy = false;
    }
  }
</script>

<div class="flex items-start gap-3 py-2 border-b border-border">
  <Badge variant={levelVariant[event.level]} class="mt-0.5">
    {$t(`activity.level.${event.level}`)}
  </Badge>
  <div class="flex-1 min-w-0">
    <div class="text-sm">
      {$t(event.message, event.messageParams)}
    </div>
    <div class="text-xs text-muted-foreground flex gap-2">
      <span>{$t(`activity.source.${event.source}`)}</span>
      <span>·</span>
      <span>{new Date(event.ts).toLocaleString()}</span>
      {#if event.backendUrl}
        <span>·</span>
        <span class="truncate">{new URL(event.backendUrl).host}</span>
      {/if}
    </div>
    {#if action}
      <div class="mt-1">
        <Button variant="outline" size="sm" disabled={busy} onclick={runAction}>
          {busy && action.kind === 'retry-sync'
            ? $t('dashboard.sync.syncing')
            : $t(ACTION_LABEL_KEY[action.kind])}
        </Button>
        {#if denied}
          <p class="text-xs text-destructive mt-1">{$t('home.access.denied')}</p>
        {/if}
      </div>
    {/if}
  </div>
</div>
