<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { getSseManager, type SseStatus } from './sse';
  import { resolveBadge, resolveTone, PULSE_DOT_CLASS } from '$lib/config/status-badges';

  let status = $state<SseStatus>('connecting');
  let unsub: (() => void) | null = null;

  onMount(() => {
    unsub = getSseManager().subscribeStatus((s) => (status = s));
  });

  onDestroy(() => {
    if (unsub) unsub();
  });

  // Maps the SSE-specific status vocabulary onto the shared connection-status
  // tones (the same ones SystemStatusCard uses for the daemon + SSE rows).
  const connectionKey = $derived(
    status === 'live' ? 'live' : status === 'reconnecting' ? 'warn' : status === 'closed' ? 'down' : 'idle',
  );

  const dotClass = $derived.by(() => {
    const dot = PULSE_DOT_CLASS[resolveTone('connection-status', connectionKey)];
    return resolveBadge('connection-status', connectionKey).pulse ? `${dot} animate-pulse` : dot;
  });

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
