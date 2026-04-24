<script lang="ts">
	import {
		Inbox,
		Send,
		CheckCircle2,
		Users,
		PlayCircle,
		Clock,
		ArrowRight,
		MessageCircle,
	} from 'lucide-svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import StatCard from '$lib/components/StatCard.svelte';
	import { Badge } from '$lib/components/ui/badge';
	import * as Card from '$lib/components/ui/card';
	import { relativeTime } from '$lib/utils/time';

	type Run = {
		id: number;
		campaignId: number;
		agentRunner: string;
		status: string;
		trigger: string;
		startedAt: string | Date;
		finishedAt: string | Date | null;
		campaignName: string | null;
	};
	type Campaign = {
		id: number;
		name: string;
		status: string;
		platformId: number;
		lastRunAt: string | Date | null;
		nextRunAt: string | Date | null;
	};

	let {
		data,
	}: {
		data: {
			stats: {
				pending: number;
				approved: number;
				sent: number;
				rejected: number;
				total: number;
				sentToday: number;
				uniqueContacts: number;
				replies: number;
			};
			recentRuns: Run[];
			campaigns: Campaign[];
		};
	} = $props();

	const RUN_STATUS_VARIANT: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
		success: 'default',
		running: 'secondary',
		failed: 'destructive',
		cancelled: 'outline',
		queued: 'outline',
	};

	const activeCampaigns = $derived(data.campaigns.filter((c) => c.status === 'active'));
	const pausedCampaigns = $derived(data.campaigns.filter((c) => c.status !== 'active'));
</script>

<PageHeader
	title="Home"
	description="Outreach overview — drafts awaiting review, recent runs, campaign status."
/>

<div class="grid grid-cols-2 md:grid-cols-5 gap-3 mb-8">
	<StatCard
		label="Pending review"
		value={data.stats.pending}
		icon={Inbox}
		accent={data.stats.pending > 0 ? 'primary' : 'default'}
		href="/inbox?state=pending_review"
		hint="Drafts to approve or reject"
	/>
	<StatCard
		label="Approved"
		value={data.stats.approved}
		icon={CheckCircle2}
		accent={data.stats.approved > 0 ? 'warning' : 'default'}
		href="/inbox?state=approved"
		hint="Waiting to be sent"
	/>
	<StatCard
		label="Sent in last 24h"
		value={data.stats.sentToday}
		icon={Send}
		accent="success"
		href="/inbox?state=sent"
		hint="Manual + extension"
	/>
	<StatCard
		label="Unique contacts"
		value={data.stats.uniqueContacts}
		icon={Users}
		href="/contacts"
		hint="Across all time"
	/>
	<StatCard
		label="Replies"
		value={data.stats.replies}
		icon={MessageCircle}
		accent={data.stats.replies > 0 ? 'success' : 'default'}
		href="/contacts"
		hint="Tracked by the daemon"
	/>
</div>

<div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
	<Card.Root size="sm">
		<Card.Header class="flex-row items-center justify-between space-y-0">
			<div>
				<Card.Title class="text-base">Recent runs</Card.Title>
				<Card.Description class="text-xs">Last 5 campaign runs</Card.Description>
			</div>
			<a
				href="/campaigns"
				class="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
			>
				All campaigns <ArrowRight class="size-3" />
			</a>
		</Card.Header>
		<Card.Content>
			{#if data.recentRuns.length === 0}
				<p class="text-sm text-muted-foreground italic py-6 text-center">
					No runs yet — start one from Campaigns.
				</p>
			{:else}
				<ul class="divide-y divide-border">
					{#each data.recentRuns as run (run.id)}
						<li class="py-2 flex items-center gap-3">
							<Badge
								variant={RUN_STATUS_VARIANT[run.status] ?? 'outline'}
								class="text-[10px] w-20 justify-center"
							>
								{run.status}
							</Badge>
							<div class="min-w-0 flex-1">
								<a
									href="/campaigns/{run.campaignId}"
									class="text-sm font-medium hover:underline truncate block"
								>
									{run.campaignName ?? `Campaign #${run.campaignId}`}
								</a>
								<div class="text-[11px] text-muted-foreground">
									<span class="font-mono">#{run.id}</span>
									· {run.trigger}
									· {run.agentRunner}
								</div>
							</div>
							<span class="text-[11px] text-muted-foreground whitespace-nowrap">
								{relativeTime(run.startedAt)}
							</span>
						</li>
					{/each}
				</ul>
			{/if}
		</Card.Content>
	</Card.Root>

	<Card.Root size="sm">
		<Card.Header class="flex-row items-center justify-between space-y-0">
			<div>
				<Card.Title class="text-base">Campaigns</Card.Title>
				<Card.Description class="text-xs">
					{activeCampaigns.length} active, {pausedCampaigns.length} paused
				</Card.Description>
			</div>
			<PlayCircle class="size-4 text-muted-foreground" />
		</Card.Header>
		<Card.Content>
			{#if data.campaigns.length === 0}
				<p class="text-sm text-muted-foreground italic py-6 text-center">
					No campaigns yet.
				</p>
			{:else}
				<ul class="divide-y divide-border">
					{#each data.campaigns.slice(0, 6) as c (c.id)}
						<li class="py-2 flex items-center gap-3">
							<span
								class="size-2 rounded-full shrink-0 {c.status === 'active'
									? 'bg-emerald-400'
									: 'bg-muted-foreground/40'}"
							></span>
							<a
								href="/campaigns/{c.id}"
								class="text-sm font-medium hover:underline truncate flex-1"
							>
								{c.name}
							</a>
							<span
								class="text-[11px] text-muted-foreground whitespace-nowrap flex items-center gap-1"
							>
								{#if c.lastRunAt}
									<Clock class="size-3" />
									{relativeTime(c.lastRunAt)}
								{:else}
									<span class="italic">never run</span>
								{/if}
							</span>
						</li>
					{/each}
				</ul>
			{/if}
		</Card.Content>
	</Card.Root>
</div>
