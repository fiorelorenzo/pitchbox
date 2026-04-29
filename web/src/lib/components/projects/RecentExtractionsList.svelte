<script lang="ts">
  import StatusBadge from '$lib/components/StatusBadge.svelte';

  type Run = {
    id: number;
    status: string;
    startedAt: string;
    finishedAt: string | null;
    error: string | null;
    params: { source?: { kind: string; value: string } } | null;
  };
  type Props = { runs: Run[] };
  let { runs }: Props = $props();
</script>

{#if runs.length === 0}
  <p class="text-sm text-muted-foreground">No extractions yet.</p>
{:else}
  <ul class="text-sm divide-y">
    {#each runs as r (r.id)}
      <li class="py-2 flex items-center gap-3">
        <span class="font-mono text-muted-foreground">#{r.id}</span>
        <StatusBadge domain="run-status" value={r.status} />
        <span class="text-muted-foreground truncate">
          {r.params?.source?.kind ?? '?'}: <code>{r.params?.source?.value ?? ''}</code>
        </span>
        <span class="ml-auto text-xs text-muted-foreground">
          {new Date(r.startedAt).toLocaleString()}
        </span>
      </li>
    {/each}
  </ul>
{/if}
