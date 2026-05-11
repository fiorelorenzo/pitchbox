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
    kind: string;
    status: string;
    trigger: string;
    agentRunner: string;
    startedAt: string | Date;
    finishedAt: string | Date | null;
    draftCount: number;
    durationMs: number | null;
    tokensUsed: number | null;
  };
  type Props = { runs: Run[] };
  let { runs }: Props = $props();

  let expandedRunId = $state<number | null>(null);
  function toggle(id: number) {
    expandedRunId = expandedRunId === id ? null : id;
  }

  function kindLabel(k: string): string {
    return k === 'campaign_skill_generation' ? 'skill-generation' : k;
  }
</script>

<Card.Root size="sm">
  <Card.Header>
    <Card.Title class="text-base">Run history</Card.Title>
    <Card.Description class="text-xs">Last {runs.length} runs (any kind)</Card.Description>
  </Card.Header>
  <Card.Content class="p-0">
    {#if runs.length === 0}
      <div class="flex flex-col items-center justify-center py-12 text-muted-foreground gap-2">
        <p class="text-sm">No runs yet</p>
      </div>
    {:else}
      <Table.Root>
        <Table.Header>
          <Table.Row>
            <Table.Head class="w-16">ID</Table.Head>
            <Table.Head>Kind</Table.Head>
            <Table.Head>Status</Table.Head>
            <Table.Head>Trigger</Table.Head>
            <Table.Head>Runner</Table.Head>
            <Table.Head>Started</Table.Head>
            <Table.Head>Duration</Table.Head>
            <Table.Head>Drafts</Table.Head>
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
              <Table.Cell class="text-xs text-muted-foreground py-3">
                {kindLabel(run.kind)}
              </Table.Cell>
              <Table.Cell class="py-3">
                <StatusBadge domain="run-status" value={run.status} />
              </Table.Cell>
              <Table.Cell class="text-xs text-muted-foreground py-3">{run.trigger}</Table.Cell>
              <Table.Cell class="text-xs py-3">
                <Badge variant="outline" class="font-mono text-[11px] py-0.5 px-1.5">
                  {run.agentRunner}
                </Badge>
              </Table.Cell>
              <Table.Cell class="text-xs text-muted-foreground py-3">
                {relativeTime(run.startedAt)}
              </Table.Cell>
              <Table.Cell class="text-xs text-muted-foreground py-3">
                {formatDuration(run.durationMs)}
              </Table.Cell>
              <Table.Cell class="py-3">
                {#if run.kind === 'campaign' && run.draftCount > 0}
                  <Badge variant="secondary" class="text-xs">{run.draftCount}</Badge>
                {:else}
                  <span class="text-xs text-muted-foreground">—</span>
                {/if}
              </Table.Cell>
              <Table.Cell class="text-xs text-muted-foreground py-3">
                {run.tokensUsed != null ? run.tokensUsed.toLocaleString() : '—'}
              </Table.Cell>
              <Table.Cell class="w-8 pl-0 py-3">
                <span
                  class="flex items-center justify-center size-7 rounded text-muted-foreground"
                  aria-hidden="true"
                >
                  {#if expanded}<ChevronUp class="size-4" />{:else}<ChevronDown class="size-4" />{/if}
                </span>
              </Table.Cell>
            </Table.Row>

            {#if expanded}
              <Table.Row class="hover:bg-transparent border-t-0">
                <Table.Cell colspan={10} class="p-0 border-t border-border/50 max-w-0">
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
