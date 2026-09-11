<script lang="ts">
  import { page } from '$app/stores';
  import { tick } from 'svelte';
  import { AlertTriangle, ChevronDown, ChevronUp } from '@lucide/svelte';
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
  import { t, type Locale } from '$lib/i18n/index.js';

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
  type RunsCursor = { startedAt: string; id: string } | null;
  type Props = {
    runs: Run[];
    totalCount: number;
    nextCursor: RunsCursor;
    projectId: number;
    highlightRunId?: number | null;
  };
  let { runs, totalCount, nextCursor, projectId, highlightRunId = null }: Props = $props();

  const locale = $derived($page.data.locale as Locale);

  let expandedRunId = $state<number | null>(null);
  function toggle(id: number) {
    expandedRunId = expandedRunId === id ? null : id;
  }

  // A ?run= deep link (mirrors CampaignRunsTab.svelte - #239, #259) can
  // change while this tab stays mounted, so expand and scroll from an
  // effect keyed on the prop instead of seeding state once at init. Keying
  // on highlightRunId alone means a manual toggle() is never fought: the
  // effect only re-runs when the deep link itself changes.
  $effect(() => {
    if (highlightRunId == null) return;
    expandedRunId = highlightRunId;
    void tick().then(() => {
      document.getElementById(`run-row-${highlightRunId}`)?.scrollIntoView({ block: 'center' });
    });
  });

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
  // no navigation, so scroll position and the expanded row stay put.
  async function loadMore() {
    if (!itemsNextCursor || loadingMore) return;
    loadingMore = true;
    loadMoreError = null;
    try {
      const params = new URLSearchParams();
      params.set('cursor_at', itemsNextCursor.startedAt);
      params.set('cursor_id', itemsNextCursor.id);
      const res = await fetch(`/projects/${projectId}?${params.toString()}`, {
        headers: { accept: 'application/json' },
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
        const message =
          res.status >= 500
            ? t(locale, 'projects.error-load-more-extractions-generic')
            : (body.error ?? body.message ?? t(locale, 'projects.error-load-more-extractions'));
        if (res.status >= 500) console.error('failed to load more extraction runs', res.status, body);
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
      loadMoreError = t(locale, 'inbox.error-network');
      toast.error(loadMoreError);
    } finally {
      loadingMore = false;
    }
  }

  function sourceLabel(p: Run['params']): { kind: string; detail: string | null } {
    const s = p?.source;
    if (!s) return { kind: '-', detail: null };
    // Upload paths are internal tmp dirs (e.g. /tmp/pitchbox-upload-<uuid>) - useless to expose.
    if (s.kind === 'upload') return { kind: t(locale, 'projects.source-badge-uploaded-folder'), detail: null };
    const v = s.value ?? '';
    const max = 64;
    const short = v.length > max ? '…' + v.slice(v.length - max) : v;
    return { kind: s.kind, detail: short };
  }
</script>

<Card.Root size="sm">
  <Card.Header>
    <Card.Title class="text-base">{t(locale, 'projects.extraction-history-title')}</Card.Title>
    <Card.Description class="text-xs"
      >{t(locale, 'projects.extraction-history-count', {
        shown: items.length,
        total: totalCount,
      })}</Card.Description
    >
  </Card.Header>
  <Card.Content class="p-0">
    {#if items.length === 0}
      <div class="flex flex-col items-center justify-center py-12 text-muted-foreground gap-2">
        <p class="text-sm">{t(locale, 'projects.no-extractions-title')}</p>
        <p class="text-xs">{t(locale, 'projects.no-extractions-body')}</p>
      </div>
    {:else}
      <!--
        `table-fixed` is critical for the expanded RunLog row below. With the
        default `table-auto` layout, the `<td colspan={9}>` containing the
        RunLog would grow to fit its longest child (long assistant messages),
        forcing the entire table - and the page - to scroll horizontally even
        though every descendant has `min-w-0`. `table-fixed` locks column
        widths to their first-row sizes, so the colspan'd row is bounded by
        the table's outer width and the inner CSS-grid wrapper can correctly
        clamp the runlog to that width.
      -->
      <Table.Root class="table-fixed w-full">
        <Table.Header>
          <Table.Row>
            <Table.Head class="w-16">{t(locale, 'projects.col-id')}</Table.Head>
            <Table.Head class="w-24">{t(locale, 'projects.status-label')}</Table.Head>
            <Table.Head class="w-24">{t(locale, 'projects.col-trigger')}</Table.Head>
            <Table.Head class="w-32">{t(locale, 'projects.col-runner')}</Table.Head>
            <Table.Head>{t(locale, 'projects.col-source')}</Table.Head>
            <Table.Head class="w-28">{t(locale, 'projects.col-started')}</Table.Head>
            <Table.Head class="w-24">{t(locale, 'projects.col-duration')}</Table.Head>
            <Table.Head class="w-20">{t(locale, 'projects.col-tokens')}</Table.Head>
            <Table.Head class="w-8"></Table.Head>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {#each items as run (run.id)}
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
              aria-label={t(locale, 'projects.toggle-run-log-aria', { id: run.id })}
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
                >{relativeTime(run.startedAt, locale)}</Table.Cell
              >
              <Table.Cell class="text-xs text-muted-foreground py-3"
                >{formatDuration(run.durationMs, locale)}</Table.Cell
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
                <Table.Cell colspan={9} class="p-0 border-t border-border/50">
                  <!--
                    The `grid grid-cols-[minmax(0,1fr)]` wrapper is intentional:
                    in a `<td>` with auto table-layout, `max-w-0` / `min-w-0`
                    on inner divs are ignored when descendant content (the
                    runlog rows + their long assistant text) needs more space,
                    so the cell expands and the rows blow past the viewport.
                    A single-column grid track of `minmax(0, 1fr)` constrains
                    children to the track width regardless of their content,
                    forcing the runlog inside to wrap at the cell's width.
                  -->
                  <div
                    transition:slide={{ duration: 200 }}
                    class="bg-muted/10 px-6 py-3 grid grid-cols-[minmax(0,1fr)] overflow-hidden"
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
            {t(locale, 'inbox.load-more')}
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
                  {t(locale, 'inbox.retry')}
                </button>
              </div>
            </div>
          {/if}
        </div>
      {/if}
    {/if}
  </Card.Content>
</Card.Root>
