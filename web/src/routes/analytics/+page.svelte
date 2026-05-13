<script lang="ts">
  import { onMount } from 'svelte';

  type Stage = { stage: string; count: number };

  let { data } = $props<{ data: { campaigns: { id: number; name: string }[] } }>();

  let campaignId = $state<string>('');
  let stages = $state<Stage[]>([]);
  let loading = $state(false);
  let error = $state<string | null>(null);

  async function load() {
    loading = true;
    error = null;
    try {
      const url = new URL('/api/analytics/funnel', window.location.origin);
      if (campaignId) url.searchParams.set('campaign_id', campaignId);
      const res = await fetch(url.toString());
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      stages = body.stages as Stage[];
    } catch (e) {
      error = (e as Error).message;
      stages = [];
    } finally {
      loading = false;
    }
  }

  onMount(load);

  $effect(() => {
    // Re-fetch when the filter changes.
    void campaignId;
    load();
  });

  const max = $derived(stages.length > 0 ? Math.max(...stages.map((s) => s.count), 1) : 1);

  function pct(curr: number, prev: number | undefined): string {
    if (prev === undefined || prev === 0) return '—';
    return `${Math.round((curr / prev) * 100)}%`;
  }
</script>

<div class="p-6 max-w-3xl">
  <h1 class="text-2xl font-semibold mb-4">Analytics</h1>

  <div class="mb-6 flex items-center gap-3">
    <label class="text-sm text-muted-foreground" for="campaign-filter">Campaign</label>
    <select
      id="campaign-filter"
      bind:value={campaignId}
      class="border border-border bg-background rounded-md px-2 py-1 text-sm"
    >
      <option value="">All campaigns</option>
      {#each data.campaigns as c (c.id)}
        <option value={String(c.id)}>{c.name}</option>
      {/each}
    </select>
  </div>

  {#if loading}
    <p class="text-sm text-muted-foreground">Loading…</p>
  {:else if error}
    <p class="text-sm text-destructive">Failed to load funnel: {error}</p>
  {:else if stages.length === 0}
    <p class="text-sm text-muted-foreground">No data.</p>
  {:else}
    <div class="flex flex-col gap-3">
      {#each stages as s, i (s.stage)}
        {@const width = Math.max(2, Math.round((s.count / max) * 100))}
        {@const prev = i > 0 ? stages[i - 1].count : undefined}
        <div>
          <div class="flex items-baseline justify-between text-sm mb-1">
            <span class="font-medium capitalize">{s.stage}</span>
            <span class="text-muted-foreground">
              {s.count}
              {#if i > 0}<span class="ml-2 font-mono text-xs">{pct(s.count, prev)}</span>{/if}
            </span>
          </div>
          <div class="h-6 bg-muted rounded-md overflow-hidden">
            <div class="h-full bg-sky-500/70" style="width: {width}%"></div>
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>
