<script lang="ts">
  import { page } from '$app/stores';
  import { t, tn, type Locale } from '$lib/i18n/index.js';
  import { onMount, onDestroy } from 'svelte';
  import { invalidateAll } from '$app/navigation';
  import { Button } from '$lib/components/ui/button';
  import { Textarea } from '$lib/components/ui/textarea';
  import { Badge } from '$lib/components/ui/badge';
  import StatusBadge from '$lib/components/StatusBadge.svelte';
  import * as Card from '$lib/components/ui/card';
  import { toast } from 'svelte-sonner';
  import { getSseManager } from '$lib/realtime/sse';
  import StreamStatusBanner from '$lib/realtime/StreamStatusBanner.svelte';

  type TuningRun = {
    id: number;
    status: string;
    startedAt: string | Date;
    finishedAt: string | Date | null;
    params: {
      objective?: string;
      mode?: string;
      generatedConfig?: Record<string, unknown> | null;
      previousConfig?: Record<string, unknown> | null;
      adopted?: boolean;
      discarded?: boolean;
    } | null;
  };

  type Props = {
    campaignId: number;
    tuningRuns: TuningRun[];
  };
  let { campaignId, tuningRuns }: Props = $props();

  const locale = $derived($page.data.locale as Locale);

  // svelte-ignore state_referenced_locally
  let objective = $state(tuningRuns[0]?.params?.objective ?? '');
  let submitting = $state(false);
  // svelte-ignore state_referenced_locally
  let runningRunId = $state<number | null>(
    tuningRuns.find((r) => r.status === 'running')?.id ?? null,
  );
  // svelte-ignore state_referenced_locally
  let selectedRunId = $state<number | null>(
    tuningRuns.find(
      (r) => r.status === 'success' && r.params?.generatedConfig && !r.params?.adopted,
    )?.id ??
      tuningRuns[0]?.id ??
      null,
  );

  const selectedRun = $derived(tuningRuns.find((r) => r.id === selectedRunId) ?? null);
  const previousJson = $derived(
    selectedRun?.params?.previousConfig
      ? JSON.stringify(selectedRun.params.previousConfig, null, 2)
      : t(locale, 'campaigns.tuning-tab.no-previous-profile'),
  );
  const generatedJson = $derived(
    selectedRun?.params?.generatedConfig
      ? JSON.stringify(selectedRun.params.generatedConfig, null, 2)
      : '',
  );

  // Hand-rolled unified diff (line-based). Plenty good for JSON.
  type DiffLine = { kind: 'eq' | 'add' | 'del'; text: string };
  function diffLines(a: string, b: string): DiffLine[] {
    const A = a.split('\n');
    const B = b.split('\n');
    // Greedy LCS using DP - fine for a few hundred lines.
    const m = A.length;
    const n = B.length;
    const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
    for (let i = m - 1; i >= 0; i--) {
      for (let j = n - 1; j >= 0; j--) {
        dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    const out: DiffLine[] = [];
    let i = 0;
    let j = 0;
    while (i < m && j < n) {
      if (A[i] === B[j]) {
        out.push({ kind: 'eq', text: A[i] });
        i++;
        j++;
      } else if (dp[i + 1][j] >= dp[i][j + 1]) {
        out.push({ kind: 'del', text: A[i] });
        i++;
      } else {
        out.push({ kind: 'add', text: B[j] });
        j++;
      }
    }
    while (i < m) out.push({ kind: 'del', text: A[i++] });
    while (j < n) out.push({ kind: 'add', text: B[j++] });
    return out;
  }
  const diff = $derived(
    selectedRun?.params?.generatedConfig ? diffLines(previousJson, generatedJson) : [],
  );

  async function tune() {
    if (!objective.trim()) {
      toast.error(t(locale, 'campaigns.tuning-tab.error-objective-required'));
      return;
    }
    submitting = true;
    try {
      const res = await fetch(`/api/campaigns/${campaignId}/skill-runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ objective, mode: 'preview' }),
      });
      const body = await res.json();
      if (res.status === 409) {
        toast.error(t(locale, 'campaigns.tuning-tab.error-already-in-progress'));
        return;
      }
      if (!res.ok) {
        toast.error(body.message ?? t(locale, 'campaigns.tuning-tab.error-start-failed'));
        return;
      }
      runningRunId = body.runId;
      toast.success(t(locale, 'campaigns.tuning-tab.toast-started', { run: body.runId }));
      await invalidateAll();
    } finally {
      submitting = false;
    }
  }

  async function adopt(runId: number) {
    const res = await fetch(`/api/campaigns/${campaignId}/skill-runs/${runId}/adopt`, {
      method: 'POST',
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      toast.error(body.error ?? t(locale, 'campaigns.tuning-tab.error-adopt-failed'));
      return;
    }
    toast.success(t(locale, 'campaigns.tuning-tab.toast-adopted'));
    await invalidateAll();
  }

  async function discard(runId: number) {
    const res = await fetch(`/api/campaigns/${campaignId}/skill-runs/${runId}/discard`, {
      method: 'POST',
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      toast.error(body.error ?? t(locale, 'campaigns.tuning-tab.error-discard-failed'));
      return;
    }
    toast.success(t(locale, 'campaigns.tuning-tab.toast-discarded'));
    await invalidateAll();
  }

  // The shared SSE singleton (web/src/lib/realtime/sse.ts), not a raw
  // EventSource: a component-owned connection would compete with every
  // other tab's stream for the same server-side capacity and its own
  // reconnect/backoff, so a dropped connection would only be visible here.
  const unsubs: Array<() => void> = [];
  onMount(() => {
    unsubs.push(
      getSseManager().on('run:finished', async (ev: MessageEvent) => {
        let payload: { campaignId?: number | null; runId?: number } = {};
        try {
          payload = JSON.parse(ev.data);
        } catch {
          /* non-JSON heartbeat: ignore */
        }
        if (payload.campaignId !== campaignId) return;
        if (runningRunId !== null && payload.runId === runningRunId) {
          runningRunId = null;
          selectedRunId = payload.runId ?? selectedRunId;
          await invalidateAll();
          toast.success(t(locale, 'campaigns.tuning-tab.toast-finished'));
        }
      }),
    );
  });
  onDestroy(() => unsubs.forEach((unsub) => unsub()));
</script>

<div class="space-y-6">
  <StreamStatusBanner active={runningRunId !== null} onReconnect={() => invalidateAll()} />
  <Card.Root size="sm">
    <Card.Header>
      <Card.Title class="text-base">{t(locale, 'campaigns.tuning-tab.title')}</Card.Title>
      <Card.Description>
        {t(locale, 'campaigns.tuning-tab.description')}
      </Card.Description>
    </Card.Header>
    <Card.Content class="space-y-3">
      <Textarea
        bind:value={objective}
        rows={4}
        placeholder={t(locale, 'campaigns.tuning-tab.objective-placeholder')}
        disabled={submitting || runningRunId !== null}
      />
      <div class="flex justify-end">
        <Button onclick={tune} loading={submitting || runningRunId !== null}>
          {runningRunId !== null ? t(locale, 'campaigns.tuning-tab.button-in-progress') : t(locale, 'campaigns.tuning-tab.title')}
        </Button>
      </div>
    </Card.Content>
  </Card.Root>

  {#if selectedRun && selectedRun.status === 'success' && selectedRun.params?.generatedConfig}
    <Card.Root size="sm">
      <Card.Header>
        <div class="flex items-center justify-between gap-3">
          <div>
            <Card.Title class="text-base">{t(locale, 'campaigns.tuning-tab.proposed-profile-title', { run: selectedRun.id })}</Card.Title>
            <Card.Description>
              {#if selectedRun.params.adopted}
                <Badge variant="secondary">{t(locale, 'campaigns.tuning-tab.badge-adopted')}</Badge>
              {:else if selectedRun.params.discarded}
                <Badge variant="outline">{t(locale, 'campaigns.tuning-tab.badge-discarded')}</Badge>
              {:else}
                {t(locale, 'campaigns.tuning-tab.badge-pending-review')}
              {/if}
            </Card.Description>
          </div>
          <div class="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onclick={() => discard(selectedRun!.id)}
              disabled={!!selectedRun.params.discarded}
            >
              {t(locale, 'campaigns.tuning-tab.discard-button')}
            </Button>
            <Button
              size="sm"
              onclick={() => adopt(selectedRun!.id)}
              disabled={!!selectedRun.params.adopted}
            >
              {t(locale, 'campaigns.tuning-tab.adopt-button')}
            </Button>
          </div>
        </div>
      </Card.Header>
      <Card.Content>
        <pre
          class="font-mono text-xs whitespace-pre-wrap bg-muted/40 p-3 rounded border max-h-[500px] overflow-auto">{#each diff as line, i (i)}<span
              class={line.kind === 'add'
                ? 'block bg-green-500/15 text-green-700 dark:text-green-300'
                : line.kind === 'del'
                  ? 'block bg-red-500/15 text-red-700 dark:text-red-300'
                  : 'block'}>{line.kind === 'add' ? '+ ' : line.kind === 'del' ? '- ' : '  '}{line.text}</span
            >{/each}</pre>
      </Card.Content>
    </Card.Root>
  {/if}

  <Card.Root size="sm">
    <Card.Header>
      <Card.Title class="text-base">{t(locale, 'campaigns.tuning-tab.history-title')}</Card.Title>
      <Card.Description>{tn(locale, 'campaigns.tuning-tab.history-count', tuningRuns.length)}</Card.Description>
    </Card.Header>
    <Card.Content>
      {#if tuningRuns.length === 0}
        <p class="text-sm text-muted-foreground">{t(locale, 'campaigns.tuning-tab.history-empty')}</p>
      {:else}
        <table class="w-full text-sm">
          <thead>
            <tr class="text-left text-xs text-muted-foreground border-b">
              <th class="py-2 font-medium">{t(locale, 'campaigns.runs-tab.col-id')}</th>
              <th class="py-2 font-medium">{t(locale, 'campaigns.runs-tab.col-started')}</th>
              <th class="py-2 font-medium">{t(locale, 'campaigns.col-status')}</th>
              <th class="py-2 font-medium">{t(locale, 'campaigns.tuning-tab.col-adopted')}</th>
              <th class="py-2 font-medium"></th>
            </tr>
          </thead>
          <tbody>
            {#each tuningRuns as r (r.id)}
              <tr class="border-b last:border-b-0">
                <td class="py-2 font-mono">#{r.id}</td>
                <td class="py-2 text-muted-foreground">
                  {new Date(r.startedAt).toLocaleString()}
                </td>
                <td class="py-2"><StatusBadge domain="run-status" value={r.status} size="sm" /></td>
                <td class="py-2">
                  {#if r.params?.adopted}
                    <Badge variant="secondary">{t(locale, 'campaigns.tuning-tab.badge-yes')}</Badge>
                  {:else if r.params?.discarded}
                    <Badge variant="outline">{t(locale, 'campaigns.tuning-tab.badge-discarded')}</Badge>
                  {:else}
                    <span class="text-muted-foreground">-</span>
                  {/if}
                </td>
                <td class="py-2 text-right">
                  {#if r.status === 'success' && r.params?.generatedConfig}
                    <Button size="sm" variant="ghost" onclick={() => (selectedRunId = r.id)}>
                      {t(locale, 'campaigns.tuning-tab.view-diff-button')}
                    </Button>
                  {/if}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      {/if}
    </Card.Content>
  </Card.Root>
</div>
