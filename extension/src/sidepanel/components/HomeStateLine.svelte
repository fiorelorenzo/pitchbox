<!-- The one line home is built around (#399/#400): what state Pitchbox is in,
     in the product's own words, with the thing that set that state named
     directly under it. The derivation is in lib/home-state.ts so it can be
     tested without a DOM; this component only renders it.

     D21 in docs/design/DECISIONS.md: one worst-of indicator, never one per
     channel, and never an aggregate without naming what set it. -->
<script lang="ts">
  import { t } from '$ext/i18n';
  import type { HomeState, HomeTone } from '$ext/home-state';

  let { state }: { state: HomeState } = $props();

  // Semantic multi-hue, the same four the rest of the extension already uses:
  // green ready, amber degraded and actionable, red stopped, muted for a
  // state that is not a fault (first run, or a first sync still due).
  const DOT: Record<HomeTone, string> = {
    ok: 'bg-emerald-500',
    pending: 'bg-muted-foreground/60',
    warn: 'bg-amber-500',
    error: 'bg-red-500',
    idle: 'bg-muted-foreground/60',
  };
</script>

<div class="flex flex-col gap-1" data-home-state={state.tone}>
  <div class="flex items-center gap-2">
    <span class="size-2.5 shrink-0 rounded-full {DOT[state.tone]}" aria-hidden="true"></span>
    <h2 class="text-base leading-tight font-semibold">{$t(state.key)}</h2>
  </div>
  {#if state.detailKey}
    <p class="pl-4 text-sm leading-snug text-muted-foreground">
      {$t(state.detailKey, state.detailParams)}
    </p>
  {/if}
</div>
