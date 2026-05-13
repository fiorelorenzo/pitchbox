<script lang="ts">
  import { ChevronDown, ChevronUp } from 'lucide-svelte';
  import { Badge } from '$lib/components/ui/badge';
  import StatusBadge from '$lib/components/StatusBadge.svelte';
  import * as Card from '$lib/components/ui/card';
  import * as Table from '$lib/components/ui/table';
  import { relativeTime, formatDuration } from '$lib/utils/time';
  import { slide } from 'svelte/transition';
  import RunLog from '$lib/components/RunLog.svelte';

  type Run = {
    id: number;
    status: string;
    trigger: string;
    agentRunner: string;
    startedAt: string;
    finishedAt: string | null;
    durationMs: number | null;
    tokensUsed: number | null;
    params: { source?: { kind: string; value: string } } | null;
  };
  type Props = { runs: Run[] };
  let { runs }: Props = $props();

  let expandedRunId = $state<number | null>(null);
  function toggle(id: number) {
    expandedRunId = expandedRunId === id ? null : id;
  }

  function sourceLabel(p: Run['params']): { kind: string; detail: string | null } {
    const s = p?.source;
    if (!s) return { kind: '-', detail: null };
    // Upload paths are internal tmp dirs (e.g. /tmp/pitchbox-upload-<uuid>) - useless to expose.
    if (s.kind === 'upload') return { kind: 'uploaded folder', detail: null };
    const v = s.value ?? '';
    const max = 64;
    const short = v.length > max ? '…' + v.slice(v.length - max) : v;
    return { kind: s.kind, detail: short };
  }
</script>

<Card.Root size="sm">
  <Card.Header>
    <Card.Title class="text-base">Extraction history</Card.Title>
    <Card.Description class="text-xs">Last {runs.length} extractions</Card.Description>
  </Card.Header>
  <Card.Content class="p-0">
    {#if runs.length === 0}
      <div class="flex flex-col items-center justify-center py-12 text-muted-foreground gap-2">
        <p class="text-sm">No extractions yet</p>
        <p class="text-xs">Click "Auto-extract" on the description above to start one.</p>
      </div>
    {:else}
      <Table.Root>
        <Table.Header>
          <Table.Row>
            <Table.Head class="w-16">ID</Table.Head>
            <Table.Head>Status</Table.Head>
            <Table.Head>Trigger</Table.Head>
            <Table.Head>Runner</Table.Head>
            <Table.Head>Source</Table.Head>
            <Table.Head>Started</Table.Head>
            <Table.Head>Duration</Table.Head>
            <Table.Head>Tokens</Table.Head>
            <Table.Head class="w-8"></Table.Head>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {#each runs as run (run.id)}
            {@const expanded = expandedRunId === run.id}
            <Table.Row
              onclick={() => toggle(run.id)}
              onkeydown={(e: KeyboardEvent) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  toggle(run.id);
                }
              }}
              tabindex={0}
              role="button"
              aria-expanded={expanded}
              aria-label="Toggle run #{run.id} log"
              class="hover:bg-muted/40 transition-colors border-b cursor-pointer {expanded
                ? 'bg-muted/30'
                : ''}"
            >
              <Table.Cell class="font-mono text-xs text-muted-foreground py-3">#{run.id}</Table.Cell>
              <Table.Cell class="py-3">
                <StatusBadge domain="run-status" value={run.status} />
              </Table.Cell>
              <Table.Cell class="text-xs text-muted-foreground py-3">{run.trigger}</Table.Cell>
              <Table.Cell class="text-xs py-3">
                <Badge variant="outline" class="font-mono text-[11px]">
                  {run.agentRunner}
                </Badge>
              </Table.Cell>
              <Table.Cell class="text-xs text-muted-foreground py-3 max-w-[260px]">
                {@const src = sourceLabel(run.params)}
                <div class="flex items-center gap-2 min-w-0">
                  <Badge variant="outline" class="font-mono text-[11px] shrink-0">
                    {src.kind}
                  </Badge>
                  {#if src.detail}
                    <code class="font-mono truncate" title={src.detail}>{src.detail}</code>
                  {/if}
                </div>
              </Table.Cell>
              <Table.Cell class="text-xs text-muted-foreground py-3"
                >{relativeTime(run.startedAt)}</Table.Cell
              >
              <Table.Cell class="text-xs text-muted-foreground py-3"
                >{formatDuration(run.durationMs)}</Table.Cell
              >
              <Table.Cell class="text-xs text-muted-foreground py-3">
                {run.tokensUsed != null ? run.tokensUsed.toLocaleString() : '-'}
              </Table.Cell>
              <Table.Cell class="w-8 pl-0 py-3">
                <span
                  class="flex items-center justify-center size-7 rounded text-muted-foreground"
                  aria-hidden="true"
                >
                  {#if expanded}
                    <ChevronUp class="size-4" />
                  {:else}
                    <ChevronDown class="size-4" />
                  {/if}
                </span>
              </Table.Cell>
            </Table.Row>

            {#if expanded}
              <Table.Row class="hover:bg-transparent border-t-0">
                <Table.Cell colspan={9} class="p-0 border-t border-border/50 max-w-0">
                  <div
                    transition:slide={{ duration: 200 }}
                    class="bg-muted/10 px-6 py-3 min-w-0 overflow-hidden"
                  >
                    <RunLog runId={run.id} />
                  </div>
                </Table.Cell>
              </Table.Row>
            {/if}
          {/each}
        </Table.Body>
      </Table.Root>
    {/if}
  </Card.Content>
</Card.Root>
