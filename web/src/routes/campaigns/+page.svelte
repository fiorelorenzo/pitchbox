<script lang="ts">
	import RunLog from '$lib/components/RunLog.svelte';
	import { invalidateAll } from '$app/navigation';
	import { Loader2 } from 'lucide-svelte';
	import { toast } from 'svelte-sonner';
	import { Button } from '$lib/components/ui/button';
	import { Badge } from '$lib/components/ui/badge';
	import * as Card from '$lib/components/ui/card';
	import * as Table from '$lib/components/ui/table';
	import { onMount, onDestroy } from 'svelte';
	import { relativeTime, formatDuration } from '$lib/utils/time';

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
	let currentRunId = $state<number | null>(null);
	let es: EventSource | null = null;

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
		// Optimistic update
		runningCampaignIds = new Set([...runningCampaignIds, id]);
		try {
			const res = await fetch('/api/run', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ campaignId: id }),
			});
			if (!res.ok) throw new Error(await res.text());
			const { runId } = await res.json();
			currentRunId = runId;
		} catch {
			toast.error('Failed to start run');
			runningCampaignIds = new Set([...runningCampaignIds].filter((x) => x !== id));
		}
	}

	// Find campaign name by runId (best effort from server data)
	function campaignNameForRun(runId: number): string {
		// we don't have per-run campaign mapping here easily; skip
		return `#${runId}`;
	}

	onMount(() => {
		es = new EventSource('/api/stream');

		es.addEventListener('run:started', async (e: MessageEvent) => {
			const { runId: rid, campaignId } = JSON.parse(e.data);
			if (campaignId) {
				runningCampaignIds = new Set([...runningCampaignIds, campaignId]);
			}
			if (currentRunId == null) {
				currentRunId = rid;
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

	// Merge server isRunning with optimistic local state
	function isRunning(c: (typeof data.campaigns)[0]): boolean {
		return c.isRunning || runningCampaignIds.has(c.id);
	}
</script>

<h1 class="text-2xl font-semibold mb-6">Campaigns</h1>

<div class="grid gap-6 lg:grid-cols-[1fr_420px]">
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
					</Table.Row>
				</Table.Header>
				<Table.Body>
					{#each data.campaigns as c (c.id)}
						{@const running = isRunning(c)}
						<Table.Row class={running ? 'border-l-2 border-green-500' : ''}>
							<Table.Cell class="font-medium">{c.name}</Table.Cell>
							<Table.Cell class="text-muted-foreground text-xs">{c.skillSlug}</Table.Cell>
							<Table.Cell>
								{#if running}
									<Badge variant="default" class="gap-1">
										<span class="size-1.5 rounded-full bg-green-300 animate-pulse inline-block"></span>
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
									<a
										href="/inbox?state=pending_review&campaign={c.id}"
										class="hover:underline"
									>
										<Badge variant="secondary" class="text-xs">
											{c.lastRunDraftCount} drafts
										</Badge>
									</a>
								{:else}
									<span class="text-muted-foreground/50 text-xs">—</span>
								{/if}
							</Table.Cell>
							<Table.Cell class="text-right">
								<Button
									onclick={() => runNow(c.id)}
									disabled={running}
									size="sm"
									variant="secondary"
								>
									{#if running}
										<Loader2 class="size-4 animate-spin mr-1" />
										Running…
									{:else}
										Run now
									{/if}
								</Button>
							</Table.Cell>
						</Table.Row>
					{/each}
				</Table.Body>
			</Table.Root>
		</Card.Content>
	</Card.Root>

	<Card.Root>
		<Card.Header>
			<Card.Title>Live log</Card.Title>
		</Card.Header>
		<Card.Content>
			<RunLog runId={currentRunId} />
		</Card.Content>
	</Card.Root>
</div>
