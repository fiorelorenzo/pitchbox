<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { daemonStatus } from '$lib/stores/daemon';
  import { getSseManager, type SseStatus } from '$lib/realtime/sse';
  import { VERSION } from '$lib/shared/version';
  import { resolveBadge, resolveTone, PULSE_DOT_CLASS, TONE_TEXT_CLASS } from '$lib/config/status-badges';

  let sseState = $state<SseStatus>('connecting');
  let unsub: (() => void) | null = null;

  onMount(() => {
    unsub = getSseManager().subscribeStatus((s) => (sseState = s));
  });
  onDestroy(() => unsub?.());

  type RowTone = 'live' | 'idle' | 'warn' | 'down';

  const daemonRow = $derived.by(() => {
    if ($daemonStatus.loading) {
      return { tone: 'idle' as RowTone, label: 'checking' };
    }
    return $daemonStatus.alive
      ? { tone: 'live' as RowTone, label: 'online' }
      : { tone: 'down' as RowTone, label: 'offline' };
  });

  const sseRow = $derived.by(() => {
    if (sseState === 'live') return { tone: 'live' as RowTone, label: 'live' };
    if (sseState === 'reconnecting')
      return { tone: 'warn' as RowTone, label: 'reconnecting' };
    if (sseState === 'closed') return { tone: 'down' as RowTone, label: 'offline' };
    return { tone: 'idle' as RowTone, label: 'connecting' };
  });

  function dotClass(tone: RowTone) {
    const dot = PULSE_DOT_CLASS[resolveTone('connection-status', tone)];
    return resolveBadge('connection-status', tone).pulse ? `${dot} animate-pulse` : dot;
  }

  function valueClass(tone: RowTone) {
    return TONE_TEXT_CLASS[resolveTone('connection-status', tone)];
  }
</script>

<div class="rounded-md border border-border bg-card/40 px-3 py-2 text-xs">
  <div class="flex items-center justify-between gap-2 py-0.5">
    <span class="flex items-center gap-2 text-muted-foreground">
      <span class="size-1.5 rounded-full shrink-0 {dotClass(daemonRow.tone)}"></span>
      Daemon
    </span>
    <span class="font-medium {valueClass(daemonRow.tone)}">{daemonRow.label}</span>
  </div>
  <div class="flex items-center justify-between gap-2 py-0.5">
    <span class="flex items-center gap-2 text-muted-foreground">
      <span class="size-1.5 rounded-full shrink-0 {dotClass(sseRow.tone)}"></span>
      Live stream
    </span>
    <span class="font-medium {valueClass(sseRow.tone)}">{sseRow.label}</span>
  </div>
  <div class="mt-1 pt-1 border-t border-border/60 text-[10px] text-muted-foreground/70 font-mono">
    pitchbox {VERSION}
  </div>
</div>
