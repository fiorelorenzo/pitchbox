<script lang="ts">
	import RunLog from '$lib/components/RunLog.svelte';
	import { invalidateAll, goto } from '$app/navigation';
	import { page } from '$app/stores';
	import { ChevronDown, ChevronUp, Square } from '@lucide/svelte';
	import { toast } from 'svelte-sonner';
	import { Button } from '$lib/components/ui/button';
	import { Badge } from '$lib/components/ui/badge';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import * as Card from '$lib/components/ui/card';
	import * as Table from '$lib/components/ui/table';
	import * as AlertDialog from '$lib/components/ui/alert-dialog';
	import { onMount, onDestroy } from 'svelte';
	import StreamStatusBanner from '$lib/realtime/StreamStatusBanner.svelte';
	import { getSseManager } from '$lib/realtime/sse';
	import { navigating } from '$app/stores';
	import { relativeTime, relativeTimeUntil, formatDuration } from '$lib/utils/time';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import { slide } from 'svelte/transition';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import PageContainer from '$lib/components/PageContainer.svelte';
	import Seo from '$lib/components/Seo.svelte';
	import EmptyState from '$lib/components/EmptyState.svelte';
	import { Megaphone } from '@lucide/svelte';
	import * as Tooltip from '$lib/components/ui/tooltip';
	import { TONE_TEXT_CLASS } from '$lib/config/status-badges';
	import { SelectField } from '$lib/components/ui/select-field';

	let {
		data,
	}: {
		data: {
			campaigns: Array<{
				id: number;
				name: string;
				skillSlug: string;
				agentRunner: string;
				status: string;
				isRunning: boolean;
				lastRunId: number | null;
				lastRunStatus: string | null;
				lastRunStartedAt: Date | null;
				lastRunFinishedAt: Date | null;
				lastRunDurationMs: number | null;
				lastRunTokens: number | null;
				lastRunDraftCount: number;
				nextRunAt: Date | null;
				project: { id: number; slug: string; name: string };
				platformSlug: string;
			}>;
			projects: Array<{ id: number; slug: string; name: string }>;
			activeProject: { id: number; slug: string; name: string } | null;
			runFilterInvalid?: string | null;
		};
	} = $props();

	type Campaign = (typeof data.campaigns)[number];

	// A stale/foreign `?run=` link (from Audit) could not be resolved to a
	// campaign server-side - say so once instead of leaving the user staring
	// at an unfiltered list that looks like the link just did nothing (#239).
	let warnedRunFilterInvalid: string | null = null;
	$effect(() => {
		if (data.runFilterInvalid != null && data.runFilterInvalid !== warnedRunFilterInvalid) {
			warnedRunFilterInvalid = data.runFilterInvalid;
			toast.warning('Run link ignored', {
				description: `Run #${data.runFilterInvalid} could not be found - showing all campaigns instead.`,
			});
		} else if (data.runFilterInvalid == null) {
			warnedRunFilterInvalid = null;
		}
	});

	function changeProject(slug: string) {
		const url = new URL($page.url);
		if (slug) url.searchParams.set('project', slug);
		else url.searchParams.delete('project');
		goto(url.pathname + url.search, { invalidateAll: true, replaceState: true });
	}

	let runningCampaignIds = $state<Set<number>>(new Set());
	// Track the latest runId per campaign (updated when a run starts).
	let runIdByCampaign = $state<Map<number, number>>(new Map());
	const unsubs: Array<() => void> = [];

	// Single-expanded campaign id.
	let expandedId = $state<number | null>(null);

	// Stop-run confirmation dialog state.
	let stopDialogOpen = $state(false);
	let stopTarget = $state<{ campaignId: number; runId: number } | null>(null);
	let stopping = $state(false);

	async function runNow(id: number) {
		// Synchronous guard: prevent double-click races.
		if (runningCampaignIds.has(id)) return;
		runningCampaignIds = new Set([...runningCampaignIds, id]);
		try {
			const res = await fetch('/api/run', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ campaignId: id }),
			});
			if (!res.ok) throw new Error(await res.text());
			const { runId, alreadyRunning } = await res.json();
			if (alreadyRunning) {
				toast.info(`Already running - showing live log`);
			}
			runIdByCampaign = new Map([...runIdByCampaign, [id, runId]]);
		} catch {
			toast.error('Failed to start run');
			runningCampaignIds = new Set([...runningCampaignIds].filter((x) => x !== id));
		}
	}

	function openStopDialog(campaignId: number, runId: number) {
		stopTarget = { campaignId, runId };
		stopDialogOpen = true;
	}

	async function confirmStop() {
		if (!stopTarget) return;
		stopping = true;
		try {
			const res = await fetch(`/api/run/${stopTarget.runId}`, { method: 'DELETE' });
			if (!res.ok) throw new Error(await res.text());
			toast.info(`Run #${stopTarget.runId} stopped`);
			stopDialogOpen = false;
			stopTarget = null;
			await invalidateAll();
		} catch (err) {
			toast.error(`Failed to stop run: ${err}`);
		} finally {
			stopping = false;
		}
	}

	onMount(() => {
		const sseManager = getSseManager();

		unsubs.push(
			sseManager.on('run:started', async (e: MessageEvent) => {
				const { runId: rid, campaignId } = JSON.parse(e.data);
				if (campaignId) {
					runningCampaignIds = new Set([...runningCampaignIds, campaignId]);
					runIdByCampaign = new Map([...runIdByCampaign, [campaignId, rid]]);
					// Auto-expand the campaign whose run just started.
					expandedId = campaignId;
				}
				toast.info(`Run #${rid} started`);
				await invalidateAll();
			}),
		);

		unsubs.push(
			sseManager.on('run:finished', async (e: MessageEvent) => {
				const { runId: rid, exitCode, campaignId, error } = JSON.parse(e.data);
				if (campaignId) {
					runningCampaignIds = new Set([...runningCampaignIds].filter((x) => x !== campaignId));
				}
				if (exitCode === 0) {
					toast.success(`Run #${rid} finished`);
				} else if (error === 'cancelled by user') {
					toast.info(`Run #${rid} cancelled`);
				} else {
					toast.error(`Run #${rid} failed`);
				}
				await invalidateAll();
			}),
		);
	});

	onDestroy(() => unsubs.forEach((unsub) => unsub()));

	function isRunning(c: (typeof data.campaigns)[0]): boolean {
		return c.isRunning || runningCampaignIds.has(c.id);
	}

	/** Effective runId for a campaign: prefer live-updated map, fall back to server data. */
	function effectiveRunId(c: (typeof data.campaigns)[0]): number | null {
		return runIdByCampaign.get(c.id) ?? c.lastRunId;
	}

	function toggleExpand(campaignId: number) {
		expandedId = expandedId === campaignId ? null : campaignId;
	}

	let isNavigating = $derived($navigating != null);

	// A dropped stream only matters here while some campaign is actually
	// running; an idle list has nothing to stream, so it must not be
	// flagged as broken.
	const anyRunning = $derived(data.campaigns.some((c) => isRunning(c)));
</script>

<PageContainer size="default">
<!-- Stop-run confirmation dialog -->
<AlertDialog.Root bind:open={stopDialogOpen}>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>Stop run #{stopTarget?.runId}?</AlertDialog.Title>
			<AlertDialog.Description>
				The in-progress claude-code subprocess will be terminated. Any drafts already created are
				kept.
			</AlertDialog.Description>
		</AlertDialog.Header>
		<AlertDialog.Footer>
			<AlertDialog.Cancel onclick={() => (stopDialogOpen = false)}>Cancel</AlertDialog.Cancel>
			<AlertDialog.Action onclick={confirmStop} disabled={stopping}>
				{#if stopping}Stopping…{:else}Stop run{/if}
			</AlertDialog.Action>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>

<Seo
	title="Campaigns"
	description="Manage outreach campaigns - trigger manual runs, review recent activity, edit cron schedules."
/>

<PageHeader
	title="Campaigns"
	description={data.activeProject
		? `Project: ${data.activeProject.name}`
		: 'Orchestrate outreach runs. Trigger a manual execution, inspect recent activity, or let the scheduler run active campaigns on their cron schedule.'}
>
	{#snippet actions()}
		<a href="/campaigns/new">
			<Button size="sm">New campaign</Button>
		</a>
	{/snippet}
</PageHeader>

<StreamStatusBanner active={anyRunning} onReconnect={() => invalidateAll()} />

<div class="mb-3 flex items-center gap-2">
	<span class="text-xs text-muted-foreground">Project</span>
	<SelectField
		value={data.activeProject?.slug ?? ''}
		onValueChange={(v) => changeProject(v)}
		options={[
			{ value: '', label: 'All projects' },
			...data.projects.map((p) => ({ value: p.slug, label: p.name })),
		]}
		size="sm"
	/>
</div>

{#if !isNavigating && data.campaigns.length === 0}
	<Card.Root size="sm">
		<Card.Content>
			<EmptyState
				icon={Megaphone}
				title="No campaigns yet"
				description={data.activeProject
					? `Create the first campaign for ${data.activeProject.name}. Each campaign pairs a playbook with an agent runner and an optional cron schedule.`
					: 'A campaign pairs a playbook (e.g. reddit-scout) with an agent runner and an optional cron schedule. Create the first one to dispatch a run.'}
				size="lg"
			>
				<a href="/campaigns/new"><Button size="sm">New campaign</Button></a>
			</EmptyState>
		</Card.Content>
	</Card.Root>
{:else}
{#snippet statusCell(c: Campaign, running: boolean)}
	{#if running}
		<StatusBadge domain="run-status" value="running" size="sm" />
	{:else}
		<Tooltip.Provider delayDuration={200}>
			<Tooltip.Root>
				<Tooltip.Trigger>
					<StatusBadge domain="campaign-status" value={c.status} size="sm" />
				</Tooltip.Trigger>
				<Tooltip.Content class="max-w-xs">
				{#if c.status === 'paused'}
						The scheduler will skip this campaign. "Run now" still works manually.
						Set it to active to resume the schedule.
					{:else if c.status === 'active'}
						The scheduler runs this automatically on its cron schedule, if one is set.
					{:else if c.status === 'safety_braked'}
						Auto-paused by the safety brake after repeated failures. Resume manually
						once resolved.
					{:else}
						Current campaign status: {c.status}
					{/if}
				</Tooltip.Content>
			</Tooltip.Root>
		</Tooltip.Provider>
	{/if}
{/snippet}

{#snippet skillInfo(c: Campaign)}
	<span class="flex items-center gap-1.5 flex-wrap">
		{c.skillSlug}
		<Badge variant="outline" class="font-mono text-[10px] py-0 px-1 h-4 text-muted-foreground/70">{c.platformSlug}</Badge>
		<Badge variant="outline" class="font-mono text-[10px] py-0 px-1 h-4 text-muted-foreground/70">{c.agentRunner}</Badge>
	</span>
{/snippet}

{#snippet lastRunCell(c: Campaign)}
	{#if c.lastRunFinishedAt}
		<div class="flex items-center gap-2 whitespace-nowrap">
			{#if c.lastRunStatus}
				<StatusBadge domain="run-status" value={c.lastRunStatus} />
			{/if}
			<span class="tabular-nums">{relativeTime(c.lastRunFinishedAt)}</span>
			{#if c.lastRunDurationMs != null}
				<span class="text-muted-foreground/60">·</span>
				<span class="tabular-nums">{formatDuration(c.lastRunDurationMs)}</span>
			{/if}
		</div>
	{:else}
		<span class="text-muted-foreground/50">-</span>
	{/if}
{/snippet}

{#snippet nextRunCell(c: Campaign)}
	{#if c.nextRunAt}
		{@const overdue = new Date(c.nextRunAt).getTime() < Date.now()}
		<span class="tabular-nums {overdue ? TONE_TEXT_CLASS.rose : 'text-muted-foreground'}">
			{relativeTimeUntil(c.nextRunAt)}
		</span>
	{:else}
		<span class="text-muted-foreground/50">-</span>
	{/if}
{/snippet}

{#snippet draftsCell(c: Campaign)}
	{#if c.lastRunId != null && c.lastRunDraftCount > 0}
		<a
			href="/inbox?state=pending_review&campaign={c.id}"
			class="hover:underline"
			onclick={(e) => e.stopPropagation()}
		>
			<Badge variant="default" class="text-xs bg-primary/80 hover:bg-primary">
				{c.lastRunDraftCount} drafts
			</Badge>
		</a>
	{:else if c.lastRunId != null}
		<Badge
			variant="outline"
			class="text-xs text-muted-foreground/50 border-dashed border-muted-foreground/30"
		>
			0 drafts
		</Badge>
	{:else}
		<span class="text-muted-foreground/50 text-xs">-</span>
	{/if}
{/snippet}

{#snippet runActions(c: Campaign, running: boolean, runId: number | null)}
	{#if running && runId != null}
		<!-- Running: show spinner label + stop button -->
		<div
			class="flex items-center gap-1"
			onclick={(e) => e.stopPropagation()}
			role="presentation"
		>
			<Button loading size="sm" variant="secondary">Running…</Button>
			<Button
				size="sm"
				variant="destructive"
				onclick={() => openStopDialog(c.id, runId)}
				title="Stop run"
			>
				<Square class="size-4" />
			</Button>
		</div>
	{:else}
		<Button
			onclick={(e) => {
				e.stopPropagation();
				if (runningCampaignIds.has(c.id) || running) return;
				runNow(c.id);
			}}
			loading={runningCampaignIds.has(c.id)}
			size="sm"
			variant="secondary"
		>
			Run now
		</Button>
	{/if}
{/snippet}

<!-- md and up: table, unchanged layout -->
<Card.Root size="sm" class="hidden md:block">
	<Card.Content class="p-0">
		<Table.Root>
			<Table.Header>
				<Table.Row class="border-b">
					<Table.Head class="text-xs font-medium text-muted-foreground/80 py-3">Name</Table.Head>
					<Table.Head class="text-xs font-medium text-muted-foreground/80 py-3">Project</Table.Head>
					<Table.Head class="text-xs font-medium text-muted-foreground/80 py-3">Skill</Table.Head>
					<Table.Head class="text-xs font-medium text-muted-foreground/80 py-3">Status</Table.Head>
					<Table.Head class="text-xs font-medium text-muted-foreground/80 py-3">Last run</Table.Head>
					<Table.Head class="text-xs font-medium text-muted-foreground/80 py-3">Next run</Table.Head>
					<Table.Head class="text-xs font-medium text-muted-foreground/80 py-3">Drafts</Table.Head>
					<Table.Head class="py-3"></Table.Head>
					<Table.Head class="w-8 py-3"></Table.Head>
				</Table.Row>
			</Table.Header>
			<Table.Body>
				{#if isNavigating}
					{#each Array(4) as _, i (i)}
						<Table.Row>
							{#each Array(9) as __, j (j)}
								<Table.Cell><Skeleton class="h-5 w-full" /></Table.Cell>
							{/each}
						</Table.Row>
					{/each}
				{:else}
					{#each data.campaigns as c (c.id)}
						{@const running = isRunning(c)}
						{@const runId = effectiveRunId(c)}
						{@const expanded = expandedId === c.id}

						<Table.Row
							onclick={() => {
								if (runId != null) toggleExpand(c.id);
							}}
							class="transition-colors border-b {runId != null
								? 'hover:bg-muted/40 cursor-pointer'
								: 'hover:bg-muted/20'} {running ? 'border-l-2 border-sky-500' : ''}"
						>
							<Table.Cell class="font-medium py-3">
								<a
									href="/campaigns/{c.id}"
									class="hover:underline"
									onclick={(e) => e.stopPropagation()}
								>
									{c.name}
								</a>
							</Table.Cell>
							<Table.Cell class="py-3">
								<a
									href={`/projects/${c.project.id}`}
									class="text-xs text-muted-foreground hover:underline"
									onclick={(e) => e.stopPropagation()}
								>
									{c.project.name}
								</a>
							</Table.Cell>
							<Table.Cell class="text-muted-foreground text-xs py-3">
								{@render skillInfo(c)}
							</Table.Cell>
							<Table.Cell class="py-3">
								{@render statusCell(c, running)}
							</Table.Cell>
							<Table.Cell class="text-xs text-muted-foreground py-3">
								{@render lastRunCell(c)}
							</Table.Cell>
							<Table.Cell class="text-xs py-3">
								{@render nextRunCell(c)}
							</Table.Cell>
							<Table.Cell class="py-3">
								{@render draftsCell(c)}
							</Table.Cell>
							<Table.Cell class="text-right py-3">
								{@render runActions(c, running, runId)}
							</Table.Cell>
							<!-- Expand/collapse chevron -->
							<Table.Cell class="w-8 pl-0 py-3">
								{#if runId != null}
									<button
										onclick={(e) => {
											e.stopPropagation();
											toggleExpand(c.id);
										}}
										class="flex items-center justify-center size-7 rounded hover:bg-muted transition-colors text-muted-foreground hover:text-foreground cursor-pointer"
										aria-label={expanded ? 'Collapse log' : 'Expand log'}
									>
										{#if expanded}
											<ChevronUp class="size-4" />
										{:else}
											<ChevronDown class="size-4" />
										{/if}
									</button>
								{/if}
							</Table.Cell>
						</Table.Row>

						<!-- Inline expanded log row -->
						{#if expanded && runId != null}
							<Table.Row class="hover:bg-transparent border-t-0">
								<Table.Cell colspan={9} class="p-0 border-t border-border/50 max-w-0">
									<div transition:slide={{ duration: 200 }} class="bg-muted/10 px-6 py-3 min-w-0 overflow-hidden">
										<RunLog {runId} />
									</div>
								</Table.Cell>
							</Table.Row>
						{/if}
					{/each}
				{/if}
			</Table.Body>
		</Table.Root>
	</Card.Content>
</Card.Root>

<!-- Below md: one card per campaign, status + actions inline so nothing is off-screen (#244) -->
<div class="md:hidden flex flex-col gap-3">
	{#if isNavigating}
		{#each Array(4) as _, i (i)}
			<Card.Root size="sm">
				<Card.Content class="space-y-3">
					<Skeleton class="h-5 w-2/3" />
					<Skeleton class="h-4 w-1/2" />
					<Skeleton class="h-8 w-full" />
				</Card.Content>
			</Card.Root>
		{/each}
	{:else}
		{#each data.campaigns as c (c.id)}
			{@const running = isRunning(c)}
			{@const runId = effectiveRunId(c)}
			{@const expanded = expandedId === c.id}

			<Card.Root size="sm" class={running ? 'border-l-2 border-l-sky-500' : ''}>
				<Card.Content class="space-y-3">
					<div class="flex items-start justify-between gap-2">
						<div class="min-w-0">
							<a href="/campaigns/{c.id}" class="font-medium hover:underline block truncate">
								{c.name}
							</a>
							<a href={`/projects/${c.project.id}`} class="text-xs text-muted-foreground hover:underline">
								{c.project.name}
							</a>
						</div>
						{@render statusCell(c, running)}
					</div>

					<div class="text-xs text-muted-foreground">
						{@render skillInfo(c)}
					</div>

					<div class="flex items-center justify-between gap-2 text-xs">
						{@render lastRunCell(c)}
						{@render draftsCell(c)}
					</div>
					<div class="flex items-center gap-1 text-xs text-muted-foreground">
						<span>Next run:</span>
						{@render nextRunCell(c)}
					</div>

					<div class="flex items-center gap-2 pt-1">
						{@render runActions(c, running, runId)}
						{#if runId != null}
							<Button variant="ghost" size="sm" onclick={() => toggleExpand(c.id)}>
								{expanded ? 'Hide log' : 'View log'}
							</Button>
						{/if}
					</div>

					{#if expanded && runId != null}
						<div transition:slide={{ duration: 200 }} class="border-t border-border/50 pt-3">
							<RunLog {runId} />
						</div>
					{/if}
				</Card.Content>
			</Card.Root>
		{/each}
	{/if}
</div>
{/if}
</PageContainer>
