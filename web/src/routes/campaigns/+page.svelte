<script lang="ts">
	import RunLog from '$lib/components/RunLog.svelte';
	import { invalidateAll } from '$app/navigation';
	import { Loader2 } from 'lucide-svelte';
	import { toast } from 'svelte-sonner';
	import { Button } from '$lib/components/ui/button';
	import { Badge } from '$lib/components/ui/badge';
	import * as Card from '$lib/components/ui/card';
	import * as Table from '$lib/components/ui/table';

	let { data }: { data: { campaigns: any[]; recentRuns: any[] } } = $props();

	let runningCampaignId = $state<number | null>(null);
	let currentRunId = $state<number | null>(null);

	const STATUS_VARIANT: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
		active: 'default',
		paused: 'secondary',
		safety_braked: 'destructive',
	};

	async function runNow(id: number) {
		runningCampaignId = id;
		try {
			const res = await fetch('/api/run', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ campaignId: id }),
			});
			if (!res.ok) throw new Error(await res.text());
			const { runId } = await res.json();
			currentRunId = runId;
			toast.info(`Run ${runId} started`);
			await invalidateAll();
		} catch (e) {
			toast.error('Failed to start run');
		} finally {
			runningCampaignId = null;
		}
	}
</script>

<h1 class="text-2xl font-semibold mb-6">Campaigns</h1>

<div class="grid gap-6 lg:grid-cols-[1fr_400px]">
	<Card.Root>
		<Card.Header>
			<Card.Title>Campaigns</Card.Title>
			<Card.Description>Trigger a manual run or wait for the scheduler</Card.Description>
		</Card.Header>
		<Card.Content>
			<Table.Root>
				<Table.Header>
					<Table.Row>
						<Table.Head>Name</Table.Head>
						<Table.Head>Skill</Table.Head>
						<Table.Head>Status</Table.Head>
						<Table.Head></Table.Head>
					</Table.Row>
				</Table.Header>
				<Table.Body>
					{#each data.campaigns as c (c.id)}
						<Table.Row>
							<Table.Cell class="font-medium">{c.name}</Table.Cell>
							<Table.Cell class="text-muted-foreground">{c.skillSlug}</Table.Cell>
							<Table.Cell>
								<Badge variant={STATUS_VARIANT[c.status] ?? 'secondary'}>
									{c.status}
								</Badge>
							</Table.Cell>
							<Table.Cell class="text-right">
								<Button
									onclick={() => runNow(c.id)}
									disabled={runningCampaignId === c.id}
									size="sm"
									variant="secondary"
								>
									{#if runningCampaignId === c.id}
										<Loader2 class="size-4 animate-spin" />
									{/if}
									Run now
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
