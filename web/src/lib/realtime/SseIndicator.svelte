<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { getSseManager, type SseStatus } from './sse';

  let status: SseStatus = $state('connecting');
  let unsub: (() => void) | null = null;

  onMount(() => {
    unsub = getSseManager().subscribeStatus((s) => (status = s));
  });

  onDestroy(() => {
    if (unsub) unsub();
  });

  const dotClass = $derived(
    status === 'live'
      ? 'bg-emerald-400 animate-pulse'
      : status === 'reconnecting'
        ? 'bg-amber-400 animate-pulse'
        : status === 'closed'
          ? 'bg-muted-foreground/40'
          : 'bg-muted-foreground/40',
  );

  const label = $derived(
    status === 'live'
      ? 'Live'
      : status === 'reconnecting'
        ? 'Reconnecting…'
        : status === 'closed'
          ? 'Offline'
          : 'Connecting…',
  );
</script>

<span class="flex items-center gap-1.5 text-xs text-muted-foreground" title="Live updates stream">
  <span class="size-2 rounded-full shrink-0 {dotClass}"></span>
  <span>{label}</span>
</span>
