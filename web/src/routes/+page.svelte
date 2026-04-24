<script lang="ts">
	import {
		Inbox,
		Send,
		CheckCircle2,
		Users,
		Clock,
		MessageCircle,
		Sparkles,
		TrendingUp,
		AlertTriangle,
	} from 'lucide-svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import Seo from '$lib/components/Seo.svelte';
	import StatCard from '$lib/components/StatCard.svelte';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
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
		tokensUsed: number | null;
		campaignName: string | null;
	};
	type Campaign = {
		id: number;
		name: string;
		status: string;
		platformId: number;
		lastRunId: number | null;
		lastRunStatus: string | null;
		lastRunStartedAt: string | Date | null;
		isRunning: boolean;
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
				createdToday: number;
				uniqueContacts: number;
				replies: number;
			};
			runStats7d: { total: number; success: number; failed: number; running: number };
			recentRuns: Run[];
			campaigns: Campaign[];
		};
	} = $props();

	const activeCampaigns = $derived(data.campaigns.filter((c) => c.status === 'active'));
	const pausedCampaigns = $derived(data.campaigns.filter((c) => c.status !== 'active'));

	const replyRate = $derived(
		data.stats.uniqueContacts > 0
			? Math.round((data.stats.replies / data.stats.uniqueContacts) * 1000) / 10
			: 0,
	);

	const successRate = $derived(
		data.runStats7d.total > 0
			? Math.round((data.runStats7d.success / data.runStats7d.total) * 100)
			: null,
	);
</script>

<Seo
	title="Home"
	description="Outreach overview — drafts awaiting review, recent runs, campaign status."
/>

<PageHeader
	title="Home"
	description="Outreach overview — drafts awaiting review, recent runs, campaign status."
/>

<!-- Primary stats -->
<div class="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3">
	<StatCard
		label="Drafts awaiting review"
		value={data.stats.pending}
		icon={Inbox}
		accent={data.stats.pending > 0 ? 'primary' : 'default'}
		href="/inbox?state=pending_review"
		hint={data.stats.createdToday > 0
			? `${data.stats.createdToday} new in the last 24h`
			: 'Nothing new to approve or reject'}
	/>
	<StatCard
		label="Approved, not sent"
		value={data.stats.approved}
		icon={CheckCircle2}
		accent={data.stats.approved > 0 ? 'warning' : 'default'}
		href="/inbox?state=approved"
		hint="Open compose to send them"
	/>
	<StatCard
		label="Messages sent (24h)"
		value={data.stats.sentToday}
		icon={Send}
		accent="success"
		href="/inbox?state=sent"
		hint="Marked as sent manually"
	/>
	<StatCard
		label="Reply rate"
		value={replyRate > 0 ? `${replyRate}%` : '—'}
		icon={MessageCircle}
		accent={replyRate > 0 ? 'success' : 'default'}
		href="/contacts"
		hint="{data.stats.replies} replies · {data.stats.uniqueContacts} contacts"
	/>
</div>

<!-- Secondary stats: 7-day run health -->
<div class="grid grid-cols-2 md:grid-cols-4 gap-3 mb-8">
	<StatCard
		label="Campaign runs (7d)"
		value={data.runStats7d.total}
		icon={Sparkles}
		hint={successRate != null ? `${successRate}% success rate` : 'No runs yet'}
	/>
	<StatCard
		label="Successful runs"
		value={data.runStats7d.success}
		icon={TrendingUp}
		accent={data.runStats7d.success > 0 ? 'success' : 'default'}
		hint="Last 7 days"
	/>
	<StatCard
		label="Failed runs"
		value={data.runStats7d.failed}
		icon={AlertTriangle}
		accent={data.runStats7d.failed > 0 ? 'destructive' : 'default'}
		hint="Last 7 days"
	/>
	<StatCard
		label="Unique people contacted"
		value={data.stats.uniqueContacts}
		icon={Users}
		href="/contacts"
		hint="All-time outreach"
	/>
</div>

<div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
	<!-- Recent runs -->
	<Card.Root size="sm">
		<Card.Header>
			<Card.Title class="text-base">Recent runs</Card.Title>
			<Card.Description class="text-xs">Last 5 campaign runs</Card.Description>
		</Card.Header>
		<Card.Content>
			{#if data.recentRuns.length === 0}
				<p class="text-sm text-muted-foreground italic py-6 text-center">
					No runs yet — start one from Campaigns.
				</p>
			{:else}
				<ul class="divide-y divide-border/60">
					{#each data.recentRuns as run (run.id)}
						<li class="py-2 flex items-center gap-3">
							<StatusBadge domain="run-status" value={run.status} class="shrink-0 w-20 justify-center" />
							<div class="min-w-0 flex-1">
								<a
									href="/campaigns/{run.campaignId}"
									class="text-sm font-medium hover:underline truncate block"
								>
									{run.campaignName ?? `Campaign #${run.campaignId}`}
								</a>
								<div class="text-[11px] text-muted-foreground flex items-center gap-1.5">
									<span class="font-mono">#{run.id}</span>
									<span>·</span>
									<span>{run.trigger}</span>
									<span>·</span>
									<span>{run.agentRunner}</span>
								</div>
							</div>
							<span class="text-[11px] text-muted-foreground whitespace-nowrap tabular-nums">
								{relativeTime(run.startedAt)}
							</span>
						</li>
					{/each}
				</ul>
			{/if}
		</Card.Content>
	</Card.Root>

	<!-- Campaigns -->
	<Card.Root size="sm">
		<Card.Header>
			<Card.Title class="text-base">Campaigns</Card.Title>
			<Card.Description class="text-xs">
				{activeCampaigns.length} active · {pausedCampaigns.length} paused
			</Card.Description>
		</Card.Header>
		<Card.Content>
			{#if data.campaigns.length === 0}
				<p class="text-sm text-muted-foreground italic py-6 text-center">No campaigns yet.</p>
			{:else}
				<ul class="divide-y divide-border/60">
					{#each data.campaigns.slice(0, 6) as c (c.id)}
						<li class="py-2 flex items-center gap-3">
							{#if c.isRunning}
								<StatusBadge domain="run-status" value="running" class="shrink-0 w-20 justify-center" />
							{:else}
								<StatusBadge
									domain="campaign-status"
									value={c.status}
									class="shrink-0 w-20 justify-center"
								/>
							{/if}
							<a
								href="/campaigns/{c.id}"
								class="text-sm font-medium hover:underline truncate flex-1 min-w-0"
							>
								{c.name}
							</a>
							<span
								class="text-[11px] text-muted-foreground whitespace-nowrap flex items-center gap-1 tabular-nums"
							>
								{#if c.lastRunStartedAt}
									<Clock class="size-3" />
									{relativeTime(c.lastRunStartedAt)}
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
