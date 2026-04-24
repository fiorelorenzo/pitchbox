<script lang="ts">
	import RunLog from '$lib/components/RunLog.svelte';
	import { invalidateAll } from '$app/navigation';
	import { ChevronDown, ChevronUp, Loader2, Square } from 'lucide-svelte';
	import { toast } from 'svelte-sonner';
	import { Button } from '$lib/components/ui/button';
	import { Badge } from '$lib/components/ui/badge';
	import * as Card from '$lib/components/ui/card';
	import * as Table from '$lib/components/ui/table';
	import * as AlertDialog from '$lib/components/ui/alert-dialog';
	import { onMount, onDestroy } from 'svelte';
	import { navigating } from '$app/stores';
	import { relativeTime, formatDuration } from '$lib/utils/time';
	import { Skeleton } from '$lib/components/ui/skeleton';

	let {
		data,
	}: {
		data: {
			campaigns: Array<{
				id: number;
				name: string;
				skillSlug: string;
				status: string;
				isRunning: boolean;
				lastRunId: number | null;
				lastRunStatus: string | null;
				lastRunStartedAt: Date | null;
				lastRunFinishedAt: Date | null;
				lastRunDurationMs: number | null;
				lastRunTokens: number | null;
				lastRunDraftCount: number;
			}>;
		};
	} = $props();

	let runningCampaignIds = $state<Set<number>>(new Set());
	// Track the latest runId per campaign (updated when a run starts).
	let runIdByCampaign = $state<Map<number, number>>(new Map());
	let es: EventSource | null = null;

	// Single-expanded campaign id.
	let expandedId = $state<number | null>(null);

	// Stop-run confirmation dialog state.
	let stopDialogOpen = $state(false);
	let stopTarget = $state<{ campaignId: number; runId: number } | null>(null);
	let stopping = $state(false);

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

	async function runNow(id: number) {
		runningCampaignIds = new Set([...runningCampaignIds, id]);
		try {
			const res = await fetch('/api/run', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ campaignId: id }),
			});
			if (!res.ok) throw new Error(await res.text());
			const { runId } = await res.json();
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
		es = new EventSource('/api/stream');

		es.addEventListener('run:started', async (e: MessageEvent) => {
			const { runId: rid, campaignId } = JSON.parse(e.data);
			if (campaignId) {
				runningCampaignIds = new Set([...runningCampaignIds, campaignId]);
				runIdByCampaign = new Map([...runIdByCampaign, [campaignId, rid]]);
				// Auto-expand the campaign whose run just started.
				expandedId = campaignId;
			}
			toast.info(`Run #${rid} started`);
			await invalidateAll();
		});

		es.addEventListener('run:finished', async (e: MessageEvent) => {
			const { runId: rid, exitCode, campaignId } = JSON.parse(e.data);
			if (campaignId) {
				runningCampaignIds = new Set([...runningCampaignIds].filter((x) => x !== campaignId));
			}
			if (exitCode === 0) {
				toast.success(`Run #${rid} finished`);
			} else {
				toast.error(`Run #${rid} failed`);
			}
			await invalidateAll();
		});
	});

	onDestroy(() => es?.close());

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
</script>

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
				{#if stopping}
					<Loader2 class="size-4 animate-spin mr-1" />
					Stopping…
				{:else}
					Stop run
				{/if}
			</AlertDialog.Action>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>

<h1 class="text-2xl font-semibold mb-6">Campaigns</h1>

<Card.Root>
	<Card.Header>
		<Card.Title>Campaigns</Card.Title>
		<Card.Description>Trigger a manual run or wait for the scheduler</Card.Description>
	</Card.Header>
	<Card.Content class="p-0">
		<Table.Root>
			<Table.Header>
				<Table.Row>
					<Table.Head>Name</Table.Head>
					<Table.Head>Skill</Table.Head>
					<Table.Head>Status</Table.Head>
					<Table.Head>Last run</Table.Head>
					<Table.Head>Drafts</Table.Head>
					<Table.Head></Table.Head>
					<Table.Head class="w-8"></Table.Head>
				</Table.Row>
			</Table.Header>
			<Table.Body>
				{#if isNavigating}
					{#each Array(4) as _, i (i)}
						<Table.Row>
							{#each Array(7) as __, j (j)}
								<Table.Cell><Skeleton class="h-5 w-full" /></Table.Cell>
							{/each}
						</Table.Row>
					{/each}
				{:else}
					{#each data.campaigns as c (c.id)}
						{@const running = isRunning(c)}
						{@const runId = effectiveRunId(c)}
						{@const expanded = expandedId === c.id}

						<Table.Row class={running ? 'border-l-2 border-green-500' : ''}>
							<Table.Cell class="font-medium">
								<a href="/campaigns/{c.id}" class="hover:underline">{c.name}</a>
							</Table.Cell>
							<Table.Cell class="text-muted-foreground text-xs">{c.skillSlug}</Table.Cell>
							<Table.Cell>
								{#if running}
									<Badge variant="default" class="gap-1">
										<span class="size-1.5 rounded-full bg-green-300 animate-pulse inline-block"
										></span>
										Running
									</Badge>
								{:else}
									<Badge variant={STATUS_VARIANT[c.status] ?? 'secondary'}>
										{c.status}
									</Badge>
								{/if}
							</Table.Cell>
							<Table.Cell class="text-xs text-muted-foreground">
								{#if c.lastRunFinishedAt}
									<div class="flex flex-col gap-0.5">
										<span>{relativeTime(c.lastRunFinishedAt)}</span>
										{#if c.lastRunStatus}
											<Badge
												variant={RUN_STATUS_VARIANT[c.lastRunStatus] ?? 'secondary'}
												class="text-[10px] py-0 px-1 h-4 w-fit"
											>
												{c.lastRunStatus}
											</Badge>
										{/if}
										{#if c.lastRunDurationMs != null}
											<span class="text-[10px]">{formatDuration(c.lastRunDurationMs)}</span>
										{/if}
									</div>
								{:else}
									<span class="text-muted-foreground/50">—</span>
								{/if}
							</Table.Cell>
							<Table.Cell>
								{#if c.lastRunId != null}
									<a href="/inbox?state=pending_review&campaign={c.id}" class="hover:underline">
										<Badge variant="secondary" class="text-xs">
											{c.lastRunDraftCount} drafts
										</Badge>
									</a>
								{:else}
									<span class="text-muted-foreground/50 text-xs">—</span>
								{/if}
							</Table.Cell>
							<Table.Cell class="text-right">
								{#if running && runId != null}
									<!-- Running: show spinner label + stop button -->
									<div class="flex items-center justify-end gap-1">
										<Button disabled size="sm" variant="secondary" class="gap-1">
											<Loader2 class="size-4 animate-spin" />
											Running…
										</Button>
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
									<Button onclick={() => runNow(c.id)} disabled={running} size="sm" variant="secondary">
										Run now
									</Button>
								{/if}
							</Table.Cell>
							<!-- Expand/collapse chevron -->
							<Table.Cell class="w-8 pl-0">
								{#if runId != null}
									<button
										onclick={() => toggleExpand(c.id)}
										class="flex items-center justify-center size-7 rounded hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
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
							<Table.Row class="hover:bg-transparent">
								<Table.Cell colspan={7} class="pt-0 pb-4 px-4">
									<div class="rounded-lg border bg-muted/30 p-4">
										<p class="text-xs font-semibold text-muted-foreground mb-3">
											Run #{runId} — Live log
										</p>
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
