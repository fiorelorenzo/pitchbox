<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { daemonStatus } from '$lib/stores/daemon';
  import { getSseManager, type SseStatus } from '$lib/realtime/sse';
  import { VERSION } from '$lib/shared/version';
  import { t } from '$lib/i18n';

  let sseState = $state<SseStatus>('connecting');
  let unsub: (() => void) | null = null;

  onMount(() => {
    unsub = getSseManager().subscribeStatus((s) => (sseState = s));
  });
  onDestroy(() => unsub?.());

  type RowTone = 'live' | 'idle' | 'warn' | 'down';

  const daemonRow = $derived.by(() => {
    if ($daemonStatus.loading) {
      return { tone: 'idle' as RowTone, label: $t('status.checking') };
    }
    return $daemonStatus.alive
      ? { tone: 'live' as RowTone, label: $t('nav.daemon.online') }
      : { tone: 'down' as RowTone, label: $t('nav.daemon.offline') };
  });

  const sseRow = $derived.by(() => {
    if (sseState === 'live') return { tone: 'live' as RowTone, label: $t('status.live') };
    if (sseState === 'reconnecting')
      return { tone: 'warn' as RowTone, label: $t('status.reconnecting') };
    if (sseState === 'closed') return { tone: 'down' as RowTone, label: $t('status.offline') };
    return { tone: 'idle' as RowTone, label: $t('status.connecting') };
  });

  function dotClass(tone: RowTone) {
    switch (tone) {
      case 'live':
        return 'bg-emerald-400 animate-pulse';
      case 'warn':
        return 'bg-amber-400 animate-pulse';
      case 'down':
        return 'bg-rose-400';
      default:
        return 'bg-muted-foreground/40';
    }
  }

  function valueClass(tone: RowTone) {
    switch (tone) {
      case 'live':
        return 'text-emerald-600 dark:text-emerald-400';
      case 'warn':
        return 'text-amber-600 dark:text-amber-400';
      case 'down':
        return 'text-rose-600 dark:text-rose-400';
      default:
        return 'text-muted-foreground';
    }
  }
</script>

<div class="rounded-md border border-border bg-card/40 px-3 py-2 text-xs">
  <div class="flex items-center justify-between gap-2 py-0.5">
    <span class="flex items-center gap-2 text-muted-foreground">
      <span class="size-1.5 rounded-full shrink-0 {dotClass(daemonRow.tone)}"></span>
      {$t('nav.daemon')}
    </span>
    <span class="font-medium {valueClass(daemonRow.tone)}">{daemonRow.label}</span>
  </div>
  <div class="flex items-center justify-between gap-2 py-0.5">
    <span class="flex items-center gap-2 text-muted-foreground">
      <span class="size-1.5 rounded-full shrink-0 {dotClass(sseRow.tone)}"></span>
      {$t('status.liveStream')}
    </span>
    <span class="font-medium {valueClass(sseRow.tone)}">{sseRow.label}</span>
  </div>
  <div class="mt-1 pt-1 border-t border-border/60 text-[10px] text-muted-foreground/70 font-mono">
    pitchbox {VERSION}
  </div>
</div>
