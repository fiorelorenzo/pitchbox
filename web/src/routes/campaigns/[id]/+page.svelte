<script lang="ts">
	import { ChevronLeft } from 'lucide-svelte';
	import { toast } from 'svelte-sonner';
	import { invalidateAll } from '$app/navigation';
	import { Button } from '$lib/components/ui/button';
	import { Badge } from '$lib/components/ui/badge';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import * as Card from '$lib/components/ui/card';
	import { formatDuration } from '$lib/utils/time';
	import Seo from '$lib/components/Seo.svelte';
	import CampaignProfileTab from '$lib/components/campaigns/CampaignProfileTab.svelte';
	import CampaignRunsTab from '$lib/components/campaigns/CampaignRunsTab.svelte';
	import RegenerateProfileDialog from '$lib/components/campaigns/RegenerateProfileDialog.svelte';
	import type { ScenarioSlug } from '@pitchbox/shared/campaigns';

	type SkillRun = { id: number; status: string; params: { objective?: string } | null };

	let {
		data,
	}: {
		data: {
			campaign: {
				id: number;
				name: string;
				skillSlug: string;
				agentRunner: string;
				status: string;
				config: Record<string, unknown> | null;
				cronExpression: string | null;
				rateLimit: unknown;
			};
			project: { id: number; slug: string; name: string } | null;
			platform: { id: number; slug: string } | null;
			runs: Array<{
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
			}>;
			skillRuns: SkillRun[];
		};
	} = $props();

	let isStarting = $state(false);
	let tab = $state<'overview' | 'profile' | 'runs'>('overview');
	let regenOpen = $state(false);

	const tabs = [
		{ k: 'overview' as const, label: 'Overview' },
		{ k: 'profile' as const, label: 'Profile' },
		{ k: 'runs' as const, label: 'Runs' },
	];

	const isDraft = $derived(data.campaign.status === 'draft');
	const configEmpty = $derived(Object.keys(data.campaign.config ?? {}).length === 0);
	const showProfileBanner = $derived(isDraft || configEmpty);

	// Summary stats from last 30 runs
	let stats = $derived.by(() => {
		const total = data.runs.length;
		const successful = data.runs.filter((r) => r.status === 'success').length;
		const failed = data.runs.filter((r) => r.status === 'failed' || r.status === 'error').length;
		const totalDrafts = data.runs.reduce((s, r) => s + r.draftCount, 0);
		const totalTokens = data.runs.reduce((s, r) => s + (r.tokensUsed ?? 0), 0);
		const durations = data.runs.filter((r) => r.durationMs != null).map((r) => r.durationMs!);
		const avgDuration =
			durations.length > 0
				? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
				: null;
		return { total, successful, failed, totalDrafts, totalTokens, avgDuration };
	});

	async function runNow() {
		if (isStarting || isDraft) return;
		isStarting = true;
		try {
			const res = await fetch('/api/run', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ campaignId: data.campaign.id }),
			});
			if (!res.ok) throw new Error(await res.text());
			const { runId, alreadyRunning } = await res.json();
			if (alreadyRunning) {
				toast.info(`Already running — showing live log`);
			} else {
				toast.success(`Run #${runId} started`);
			}
			await invalidateAll();
		} catch (e) {
			toast.error('Failed to start run', { description: (e as Error).message });
		} finally {
			isStarting = false;
		}
	}

	const lastObjective = $derived(data.skillRuns[0]?.params?.objective ?? '');
</script>

<Seo
	title={data.campaign.name}
	description="Campaign detail — cron schedule, recent runs, agent configuration."
/>

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

<!-- Page header -->
<header class="mb-4 flex items-start justify-between gap-4">
	<div class="min-w-0 space-y-1.5">
		<div class="flex items-center gap-3 flex-wrap">
			<h1 class="text-2xl font-semibold tracking-tight leading-none">{data.campaign.name}</h1>
			<StatusBadge domain="campaign-status" value={data.campaign.status} size="sm" />
			<Badge variant="outline" class="font-mono text-[11px]">{data.campaign.skillSlug}</Badge>
			<Badge variant="outline" class="font-mono text-[11px] text-muted-foreground"
				>{data.campaign.agentRunner}</Badge
			>
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
	<Button onclick={runNow} loading={isStarting} size="sm" disabled={isDraft || isStarting}>
		{isStarting ? 'Starting…' : 'Run now'}
	</Button>
</header>

<!-- Tabs -->
<div class="flex gap-2 border-b border-border mb-6">
	{#each tabs as t (t.k)}
		<button
			type="button"
			class={`px-3 py-2 text-sm border-b-2 ${tab === t.k ? 'border-foreground' : 'border-transparent text-muted-foreground'}`}
			onclick={() => (tab = t.k)}
		>
			{t.label}
		</button>
	{/each}
</div>

{#if tab === 'overview'}
	{#if showProfileBanner}
		<div
			class="mb-4 flex items-center justify-between gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-300"
		>
			<span>Profile not yet generated — generate it before running.</span>
			<Button size="sm" variant="outline" onclick={() => (regenOpen = true)}>Generate now</Button>
		</div>
	{/if}

	<div class="grid gap-4 md:grid-cols-2 mb-6">
		<!-- Config card -->
		<Card.Root size="sm">
			<Card.Header>
				<Card.Title class="text-base">Configuration</Card.Title>
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
				<p class="text-xs text-muted-foreground">
					View profile in the
					<button
						type="button"
						class="underline hover:text-foreground"
						onclick={() => (tab = 'profile')}>Profile tab</button
					>.
				</p>
			</Card.Content>
		</Card.Root>

		<!-- Recent activity summary card -->
		<Card.Root size="sm">
			<Card.Header>
				<Card.Title class="text-base">Recent activity</Card.Title>
				<Card.Description>Last {data.runs.length} runs</Card.Description>
			</Card.Header>
			<Card.Content>
				<dl class="grid grid-cols-2 gap-3">
					<div>
						<dt class="text-xs text-muted-foreground">Total runs</dt>
						<dd class="text-2xl font-semibold">{stats.total}</dd>
					</div>
					<div>
						<dt class="text-xs text-muted-foreground">Successful</dt>
						<dd class="text-2xl font-semibold text-green-600">{stats.successful}</dd>
					</div>
					<div>
						<dt class="text-xs text-muted-foreground">Failed</dt>
						<dd class="text-2xl font-semibold text-red-600">{stats.failed}</dd>
					</div>
					<div>
						<dt class="text-xs text-muted-foreground">Total drafts</dt>
						<dd class="text-2xl font-semibold">{stats.totalDrafts}</dd>
					</div>
					<div>
						<dt class="text-xs text-muted-foreground">Total tokens</dt>
						<dd class="text-2xl font-semibold">{stats.totalTokens.toLocaleString()}</dd>
					</div>
					<div>
						<dt class="text-xs text-muted-foreground">Avg duration</dt>
						<dd class="text-2xl font-semibold">{formatDuration(stats.avgDuration)}</dd>
					</div>
				</dl>
			</Card.Content>
		</Card.Root>
	</div>
{:else if tab === 'profile'}
	<CampaignProfileTab
		campaignId={data.campaign.id}
		scenarioSlug={data.campaign.skillSlug as ScenarioSlug}
		initialConfig={data.campaign.config ?? {}}
		skillRuns={data.skillRuns}
	/>
{:else}
	<CampaignRunsTab runs={data.runs} />
{/if}

<RegenerateProfileDialog
	open={regenOpen}
	onOpenChange={(v) => (regenOpen = v)}
	campaignId={data.campaign.id}
	initialObjective={lastObjective}
	onLaunched={() => {
		invalidateAll();
		tab = 'profile';
	}}
/>
