<script lang="ts">
  import { AlertTriangle, ChevronDown, ChevronUp } from '@lucide/svelte';
  import { tick } from 'svelte';
  import { toast } from 'svelte-sonner';
  import { Badge } from '$lib/components/ui/badge';
  import { Button } from '$lib/components/ui/button';
  import StatusBadge from '$lib/components/StatusBadge.svelte';
  import * as Card from '$lib/components/ui/card';
  import * as Table from '$lib/components/ui/table';
  import { relativeTime, formatDuration } from '$lib/utils/time';
  import { slide } from 'svelte/transition';
  import RunLog from '$lib/components/RunLog.svelte';
  import { TONE_BANNER_CLASS } from '$lib/config/status-badges';

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
    costUsd?: string | number | null;
    failureReason?: string | null;
  };
  type RunsCursor = { startedAt: string; id: string } | null;
  type Props = {
    runs: Run[];
    totalCount: number;
    nextCursor: RunsCursor;
    campaignId: number;
    highlightRunId?: number | null;
  };
  let { runs, totalCount, nextCursor, campaignId, highlightRunId = null }: Props = $props();

  let expandedRunId = $state<number | null>(null);
  function toggle(id: number) {
    expandedRunId = expandedRunId === id ? null : id;
  }

  // Only the rows appended via "Load more" live in state; the server page
  // (`runs`, from the loader on first render or a real navigation /
  // invalidateAll()) stays the source of truth and is read directly, so
  // `items` is correct during SSR too - nothing captures a stale initial
  // value the way seeding local state from a prop would. `appendedCursor`
  // shadows `nextCursor` only once a page past the first has been fetched
  // (`undefined` means "still page one", distinct from `null`, which means
  // "no more pages").
  let appended = $state<Run[]>([]);
  let appendedCursor = $state<RunsCursor | undefined>(undefined);
  let loadingMore = $state(false);
  let loadMoreError = $state<string | null>(null);

  const items = $derived([...runs, ...appended]);
  const itemsNextCursor = $derived(appendedCursor === undefined ? nextCursor : appendedCursor);

  // Reset accumulated "Load more" state whenever the upstream `runs` page
  // changes underneath us - a real navigation or invalidateAll() - so the
  // list always starts back at page one of whatever now renders
  // server-side (mirrors /audit and /inbox). Reading `runs` here is what
  // makes the effect re-run when it changes.
  $effect(() => {
    void runs;
    appended = [];
    appendedCursor = undefined;
    loadMoreError = null;
  });

  // Fetches the next page from the co-located `+server.ts` and appends it -
  // no navigation, so scroll position and the expanded row stay put. Rows
  // already present are skipped: the out-of-band `?run=` row merged in
  // ahead of its natural page would otherwise be duplicated once paging
  // reaches it.
  async function loadMore() {
    if (!itemsNextCursor || loadingMore) return;
    loadingMore = true;
    loadMoreError = null;
    try {
      const params = new URLSearchParams();
      params.set('cursor_at', itemsNextCursor.startedAt);
      params.set('cursor_id', itemsNextCursor.id);
      const res = await fetch(`/campaigns/${campaignId}?${params.toString()}`, {
        headers: { accept: 'application/json' },
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
        const message =
          res.status >= 500
            ? 'Could not load more runs. Please try again.'
            : (body.error ?? body.message ?? 'Could not load more runs.');
        if (res.status >= 500) console.error('failed to load more runs', res.status, body);
        loadMoreError = message;
        toast.error(message);
        return;
      }
      const nextPage = (await res.json()) as {
        runs: Run[];
        totalCount: number;
        nextCursor: RunsCursor;
      };
      const existingIds = new Set(items.map((r) => r.id));
      appended = [...appended, ...nextPage.runs.filter((r) => !existingIds.has(r.id))];
      appendedCursor = nextPage.nextCursor;
    } catch {
      loadMoreError = 'Could not reach the server. Check your connection and try again.';
      toast.error(loadMoreError);
    } finally {
      loadingMore = false;
    }
  }

  // A ?run= deep link (#239) can change while this tab stays mounted, for
  // instance when following a second link from a notification, so expand and
  // scroll from an effect keyed on the prop instead of seeding state once at
  // init. Keying on highlightRunId alone means a manual toggle() is never
  // fought: the effect only re-runs when the deep link itself changes.
  $effect(() => {
    if (highlightRunId == null) return;
    expandedRunId = highlightRunId;
    void tick().then(() => {
      document.getElementById(`run-row-${highlightRunId}`)?.scrollIntoView({ block: 'center' });
    });
  });

  function kindLabel(k: string): string {
    return k === 'campaign_skill_generation' ? 'skill-generation' : k;
  }

  // Small filter on top of the table - only the reasons present in the
  // currently loaded rows are listed, plus an "All failures" reset entry.
  let failureFilter = $state<string | null>(null);
  const failureReasons = $derived(
    Array.from(
      new Set(
        items
          .filter((r) => r.status === 'failed' && typeof r.failureReason === 'string')
          .map((r) => r.failureReason as string),
      ),
    ).sort(),
  );
  const visibleRuns = $derived(
    failureFilter ? items.filter((r) => r.failureReason === failureFilter) : items,
  );
</script>

<Card.Root size="sm">
  <Card.Header>
    <Card.Title class="text-base">Run history</Card.Title>
    <Card.Description class="text-xs">Showing {items.length} of {totalCount} runs (any kind)</Card.Description>
    {#if failureReasons.length > 0}
      <div class="flex flex-wrap items-center gap-1.5 pt-2">
        <span class="text-xs text-muted-foreground">Filter failures:</span>
        <button
          type="button"
          class="text-xs rounded px-1.5 py-0.5 border {failureFilter === null
            ? 'bg-muted font-medium'
            : 'text-muted-foreground'}"
          onclick={() => (failureFilter = null)}
        >
          All
        </button>
        {#each failureReasons as reason (reason)}
          <button
            type="button"
            class="text-xs rounded px-1.5 py-0.5 border font-mono {failureFilter === reason
              ? 'bg-muted font-medium'
              : 'text-muted-foreground'}"
            onclick={() => (failureFilter = reason)}
          >
            {reason}
          </button>
        {/each}
      </div>
    {/if}
  </Card.Header>
  <Card.Content class="p-0">
    {#if visibleRuns.length === 0}
      <div class="flex flex-col items-center justify-center py-12 text-muted-foreground gap-2">
        <p class="text-sm">
          {items.length === 0 ? 'No runs yet' : 'No runs match this filter'}
        </p>
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
            <Table.Head>Cost</Table.Head>
            <Table.Head class="w-8"></Table.Head>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {#each visibleRuns as run (run.id)}
            {@const expanded = expandedRunId === run.id}
            <Table.Row
              id="run-row-{run.id}"
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
                <div class="flex items-center gap-1.5">
                  <StatusBadge domain="run-status" value={run.status} />
                  {#if run.status === 'failed' && run.failureReason}
                    <Badge variant="outline" class="font-mono text-[10px] py-0 px-1.5">
                      {run.failureReason}
                    </Badge>
                  {/if}
                </div>
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
                  <span class="text-xs text-muted-foreground">-</span>
                {/if}
              </Table.Cell>
              <Table.Cell class="text-xs text-muted-foreground py-3">
                {run.tokensUsed != null ? run.tokensUsed.toLocaleString() : '-'}
              </Table.Cell>
              <Table.Cell class="text-xs text-muted-foreground py-3 tabular-nums">
                {run.costUsd != null ? `$${Number(run.costUsd).toFixed(2)}` : '-'}
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
                <Table.Cell colspan={11} class="p-0 border-t border-border/50 max-w-0">
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
      {#if itemsNextCursor}
        <div class="flex flex-col items-center gap-2 py-3">
          <Button variant="outline" size="sm" onclick={loadMore} loading={loadingMore}>
            Load more
          </Button>
          {#if loadMoreError}
            <div
              role="alert"
              class="flex max-w-sm items-start gap-2 rounded-lg border px-3 py-2 text-xs {TONE_BANNER_CLASS.rose}"
            >
              <AlertTriangle class="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
              <div class="flex-1">
                <p>{loadMoreError}</p>
                <button
                  type="button"
                  onclick={loadMore}
                  class="mt-1 underline underline-offset-2 hover:no-underline"
                >
                  Retry
                </button>
              </div>
            </div>
          {/if}
        </div>
      {/if}
    {/if}
  </Card.Content>
</Card.Root>
