<script lang="ts">
	import { Loader2, ChevronLeft, ChevronDown, ChevronUp } from 'lucide-svelte';
	import { toast } from 'svelte-sonner';
	import { invalidateAll } from '$app/navigation';
	import { navigating } from '$app/stores';
	import { Button } from '$lib/components/ui/button';
	import { Badge } from '$lib/components/ui/badge';
	import * as Card from '$lib/components/ui/card';
	import * as Table from '$lib/components/ui/table';
	import * as Tooltip from '$lib/components/ui/tooltip';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import { relativeTime, formatDuration } from '$lib/utils/time';
	import { slide } from 'svelte/transition';
	import RunLog from '$lib/components/RunLog.svelte';

	let {
		data,
	}: {
		data: {
			campaign: {
				id: number;
				name: string;
				skillSlug: string;
				status: string;
				config: unknown;
				cronExpression: string | null;
				rateLimit: unknown;
			};
			project: { id: number; slug: string; name: string } | null;
			platform: { id: number; slug: string } | null;
			runs: Array<{
				id: number;
				status: string;
				trigger: string;
				startedAt: Date | string;
				finishedAt: Date | string | null;
				draftCount: number;
				durationMs: number | null;
				tokensUsed: number | null;
			}>;
		};
	} = $props();

	let isStarting = $state(false);
	// Single-expanded run id in the history table.
	let expandedRunId = $state<number | null>(null);

	const STATUS_VARIANT: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
		active: 'default',
		paused: 'secondary',
		safety_braked: 'destructive',
	};

	const RUN_STATUS_VARIANT: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
		success: 'default',
		running: 'default',
		failed: 'destructive',
		queued: 'secondary',
		error: 'destructive',
	};

	const RUN_STATUS_COLOR: Record<string, string> = {
		success: 'bg-green-500/15 text-green-700 border-green-200',
		failed: 'bg-red-500/15 text-red-700 border-red-200',
		error: 'bg-red-500/15 text-red-700 border-red-200',
		running: 'bg-indigo-500/15 text-indigo-700 border-indigo-200',
		queued: 'bg-muted text-muted-foreground border-border',
	};

	// Summary stats from last 30 runs
	let stats = $derived(() => {
		const total = data.runs.length;
		const successful = data.runs.filter((r) => r.status === 'success').length;
		const failed = data.runs.filter((r) => r.status === 'failed' || r.status === 'error').length;
		const totalDrafts = data.runs.reduce((s, r) => s + r.draftCount, 0);
		const totalTokens = data.runs.reduce((s, r) => s + (r.tokensUsed ?? 0), 0);
		const durations = data.runs.filter((r) => r.durationMs != null).map((r) => r.durationMs!);
		const avgDuration =
			durations.length > 0 ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : null;
		return { total, successful, failed, totalDrafts, totalTokens, avgDuration };
	});

	async function runNow() {
		isStarting = true;
		try {
			const res = await fetch('/api/run', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ campaignId: data.campaign.id }),
			});
			if (!res.ok) throw new Error(await res.text());
			const { runId } = await res.json();
			toast.success(`Run #${runId} started`);
			await invalidateAll();
		} catch (e) {
			toast.error('Failed to start run', { description: (e as Error).message });
		} finally {
			isStarting = false;
		}
	}

	function toggleRunExpand(runId: number) {
		expandedRunId = expandedRunId === runId ? null : runId;
	}

	let isNavigating = $derived($navigating != null);
</script>

<!-- Breadcrumb -->
<nav class="flex items-center gap-1.5 text-sm text-muted-foreground mb-2">
	<a
		href="/campaigns"
		class="hover:text-foreground transition-colors inline-flex items-center gap-1"
	>
		<ChevronLeft class="size-3.5" />
		Campaigns
	</a>
</nav>

<!-- Page header: single tidy row -->
<header class="mb-6 flex items-start justify-between gap-4">
	<div class="min-w-0 space-y-1.5">
		<div class="flex items-center gap-3 flex-wrap">
			<h1 class="text-2xl font-semibold tracking-tight leading-none">{data.campaign.name}</h1>
			<Badge variant={STATUS_VARIANT[data.campaign.status] ?? 'secondary'}>
				{data.campaign.status}
			</Badge>
			<Badge variant="outline" class="font-mono text-[11px]">{data.campaign.skillSlug}</Badge>
		</div>
		<p class="text-xs text-muted-foreground">
			{#if data.project}
				Project <span class="font-mono text-foreground">{data.project.slug}</span>
				{#if data.platform}
					·
					<span class="font-mono">{data.platform.slug}</span>
				{/if}
				·
			{/if}
			Configuration, activity, and run history.
		</p>
	</div>
	<Button onclick={runNow} loading={isStarting} size="sm">
		{isStarting ? 'Starting…' : 'Run now'}
	</Button>
</header>

<!-- Two cards: config + activity -->
<div class="grid gap-4 md:grid-cols-2 mb-6">
	<!-- Config card -->
	<Card.Root>
		<Card.Header class="pb-3">
			<div class="flex items-center justify-between">
				<Card.Title class="text-base">Configuration</Card.Title>
				<Tooltip.Provider>
					<Tooltip.Root>
						<Tooltip.Trigger>
							{#snippet child({ props })}
								<Button {...props} variant="outline" size="sm" disabled>Edit config</Button>
							{/snippet}
						</Tooltip.Trigger>
						<Tooltip.Content>Config editing ships in M6</Tooltip.Content>
					</Tooltip.Root>
				</Tooltip.Provider>
			</div>
		</Card.Header>
		<Card.Content class="space-y-3">
			{#if data.campaign.cronExpression}
				<div>
					<p class="text-xs text-muted-foreground uppercase tracking-wide mb-1">Cron</p>
					<code class="font-mono text-xs bg-muted px-2 py-1 rounded"
						>{data.campaign.cronExpression}</code
					>
				</div>
			{/if}
			{#if data.campaign.rateLimit && JSON.stringify(data.campaign.rateLimit) !== '{}'}
				<div>
					<p class="text-xs text-muted-foreground uppercase tracking-wide mb-1">Rate limit</p>
					<pre class="font-mono text-xs whitespace-pre-wrap bg-muted p-2 rounded">{JSON.stringify(
							data.campaign.rateLimit,
							null,
							2
						)}</pre>
				</div>
			{/if}
			<div>
				<p class="text-xs text-muted-foreground uppercase tracking-wide mb-1">Config</p>
				<pre class="font-mono text-xs whitespace-pre-wrap bg-muted p-2 rounded overflow-auto max-h-48">{JSON.stringify(
						data.campaign.config,
						null,
						2
					)}</pre>
			</div>
		</Card.Content>
	</Card.Root>

	<!-- Recent activity summary card -->
	<Card.Root>
		<Card.Header class="pb-3">
			<Card.Title class="text-base">Recent activity</Card.Title>
			<Card.Description>Last {data.runs.length} runs</Card.Description>
		</Card.Header>
		<Card.Content>
			<dl class="grid grid-cols-2 gap-3">
				<div>
					<dt class="text-xs text-muted-foreground">Total runs</dt>
					<dd class="text-2xl font-semibold">{stats().total}</dd>
				</div>
				<div>
					<dt class="text-xs text-muted-foreground">Successful</dt>
					<dd class="text-2xl font-semibold text-green-600">{stats().successful}</dd>
				</div>
				<div>
					<dt class="text-xs text-muted-foreground">Failed</dt>
					<dd class="text-2xl font-semibold text-red-600">{stats().failed}</dd>
				</div>
				<div>
					<dt class="text-xs text-muted-foreground">Total drafts</dt>
					<dd class="text-2xl font-semibold">{stats().totalDrafts}</dd>
				</div>
				<div>
					<dt class="text-xs text-muted-foreground">Total tokens</dt>
					<dd class="text-2xl font-semibold">{stats().totalTokens.toLocaleString()}</dd>
				</div>
				<div>
					<dt class="text-xs text-muted-foreground">Avg duration</dt>
					<dd class="text-2xl font-semibold">{formatDuration(stats().avgDuration)}</dd>
				</div>
			</dl>
		</Card.Content>
	</Card.Root>
</div>

<!-- Run history -->
<Card.Root>
	<Card.Header>
		<Card.Title>Run history</Card.Title>
		<Card.Description>Last 30 runs</Card.Description>
	</Card.Header>
	<Card.Content class="p-0">
		{#if isNavigating}
			<div class="p-4 space-y-2">
				{#each Array(6) as _, i (i)}
					<Skeleton class="h-10 w-full" />
				{/each}
			</div>
		{:else if data.runs.length === 0}
			<div class="flex flex-col items-center justify-center py-16 text-muted-foreground gap-2">
				<p class="text-sm">No runs yet</p>
				<p class="text-xs">Click "Run now" above to kick off the first run.</p>
			</div>
		{:else}
			<Table.Root>
				<Table.Header>
					<Table.Row>
						<Table.Head class="w-16">ID</Table.Head>
						<Table.Head>Status</Table.Head>
						<Table.Head>Trigger</Table.Head>
						<Table.Head>Started</Table.Head>
						<Table.Head>Duration</Table.Head>
						<Table.Head>Drafts</Table.Head>
						<Table.Head>Tokens</Table.Head>
						<Table.Head class="w-8"></Table.Head>
					</Table.Row>
				</Table.Header>
				<Table.Body>
					{#each data.runs as run (run.id)}
						{@const expanded = expandedRunId === run.id}
						<Table.Row class="hover:bg-muted/40 transition-colors border-b">
							<Table.Cell class="font-mono text-xs text-muted-foreground py-3">#{run.id}</Table.Cell>
							<Table.Cell class="py-3">
								<span
									class="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border font-medium {RUN_STATUS_COLOR[
										run.status
									] ?? 'bg-muted text-muted-foreground border-border'}"
								>
									{#if run.status === 'running'}
										<Loader2 class="size-3 animate-spin" />
									{/if}
									{run.status}
								</span>
							</Table.Cell>
							<Table.Cell class="text-xs text-muted-foreground py-3">{run.trigger}</Table.Cell>
							<Table.Cell class="text-xs text-muted-foreground py-3"
								>{relativeTime(run.startedAt)}</Table.Cell
							>
							<Table.Cell class="text-xs text-muted-foreground py-3"
								>{formatDuration(run.durationMs)}</Table.Cell
							>
							<Table.Cell class="py-3">
								{#if run.draftCount > 0}
									<a href="/inbox?run={run.id}">
										<Badge variant="secondary" class="text-xs cursor-pointer hover:bg-accent">
											{run.draftCount}
										</Badge>
									</a>
								{:else}
									<span class="text-xs text-muted-foreground">—</span>
								{/if}
							</Table.Cell>
							<Table.Cell class="text-xs text-muted-foreground py-3">
								{run.tokensUsed != null ? run.tokensUsed.toLocaleString() : '—'}
							</Table.Cell>
							<Table.Cell class="w-8 pl-0 py-3">
								<button
									onclick={() => toggleRunExpand(run.id)}
									class="flex items-center justify-center size-7 rounded hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
									aria-label={expanded ? 'Collapse log' : 'Expand log'}
								>
									{#if expanded}
										<ChevronUp class="size-4" />
									{:else}
										<ChevronDown class="size-4" />
									{/if}
								</button>
							</Table.Cell>
						</Table.Row>

						<!-- Inline expanded log row -->
						{#if expanded}
							<Table.Row class="hover:bg-transparent border-t-0">
								<Table.Cell colspan={8} class="p-0 border-t border-border/50">
									<div transition:slide={{ duration: 200 }} class="bg-muted/10 px-6 py-3">
										<div class="flex items-center gap-2 mb-3">
											<span
												class="size-1.5 rounded-full shrink-0 {run.status === 'running'
													? 'bg-green-400 animate-pulse'
													: 'bg-muted-foreground/40'}"
											></span>
											<span class="text-xs text-muted-foreground">Run log</span>
											<span class="ml-auto text-xs text-muted-foreground/50 font-mono"
												>Run #{run.id}</span
											>
										</div>
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
