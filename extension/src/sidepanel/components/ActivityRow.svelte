<!-- Single row in the Activity tab list. -->
<script lang="ts">
  import { t } from '$ext/i18n';
  import { Badge } from '$ui/badge';
  import { type ActivityEvent } from '$ext/activity';

  let { event }: { event: ActivityEvent } = $props();

  const levelVariant = {
    info: 'secondary',
    warn: 'outline',
    error: 'destructive',
  } as const;
</script>

<div class="flex items-start gap-3 py-2 border-b border-border">
  <Badge variant={levelVariant[event.level]} class="mt-0.5 capitalize">
    {event.level}
  </Badge>
  <div class="flex-1 min-w-0">
    <div class="text-sm">
      {$t(event.message, event.messageParams)}
    </div>
    <div class="text-xs text-muted-foreground flex gap-2">
      <span>{event.source}</span>
      <span>·</span>
      <span>{new Date(event.ts).toLocaleString()}</span>
      {#if event.backendUrl}
        <span>·</span>
        <span class="truncate">{new URL(event.backendUrl).host}</span>
      {/if}
    </div>
  </div>
</div>
