<script lang="ts">
	import { ChevronLeft, Loader2 } from '@lucide/svelte';
	import { onMount, onDestroy } from 'svelte';
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
	import CampaignTuningTab from '$lib/components/campaigns/CampaignTuningTab.svelte';
	import RegenerateProfileDialog from '$lib/components/campaigns/RegenerateProfileDialog.svelte';
	import type { ScenarioSlug } from '@pitchbox/shared/campaigns';

	type SkillRun = { id: number; status: string; params: { objective?: string } | null };

	type ReadinessIssue = {
		id:
			| 'profile_missing'
			| 'profile_invalid'
			| 'profile_generating'
			| 'no_account'
			| 'runner_unavailable';
		title: string;
		hint: string;
		fix: {
			label: string;
			kind: 'profile' | 'accounts' | 'runner' | 'progress';
			href?: string;
		};
	};

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
				failureReason?: string | null;
			}>;
			skillRuns: SkillRun[];
			tuningRuns: Array<{
				id: number;
				status: string;
				startedAt: string | Date;
				finishedAt: string | Date | null;
				params: Record<string, unknown> | null;
			}>;
			readiness: {
				ready: boolean;
				issues: ReadinessIssue[];
				generatingProfile: boolean;
				campaignRunning: boolean;
			};
		};
	} = $props();

	let isStarting = $state(false);
	let tab = $state<'overview' | 'profile' | 'tuning' | 'runs'>('overview');
	let regenOpen = $state(false);

	// Live-refresh readiness + run lists when a profile-gen or campaign run
	// starts or finishes (this tab, another tab, or the daemon). Without this,
	// the banner stays stuck on the snapshot taken at page load.
	let es: EventSource | null = null;
	onMount(() => {
		es = new EventSource('/api/stream');
		const refreshIfRelevant = (e: MessageEvent) => {
			try {
				const payload = JSON.parse(e.data);
				if (payload?.campaignId === data.campaign.id) void invalidateAll();
			} catch {
				// non-JSON heartbeat: ignore
			}
		};
		es.addEventListener('run:started', refreshIfRelevant);
		es.addEventListener('run:finished', refreshIfRelevant);
		es.addEventListener('run:failed', refreshIfRelevant);
	});
	onDestroy(() => es?.close());

	const tabs = [
		{ k: 'overview' as const, label: 'Overview' },
		{ k: 'profile' as const, label: 'Profile' },
		{ k: 'tuning' as const, label: 'Tuning' },
		{ k: 'runs' as const, label: 'Runs' },
	];

	const isDraft = $derived(data.campaign.status === 'draft');
	const ready = $derived(data.readiness?.ready ?? false);
	const issues = $derived(data.readiness?.issues ?? []);
	const generatingProfile = $derived(data.readiness?.generatingProfile ?? false);
	const campaignRunning = $derived(data.readiness?.campaignRunning ?? false);
	const hasRateLimit = $derived(
		!!data.campaign.rateLimit && JSON.stringify(data.campaign.rateLimit) !== '{}',
	);
	const hasConfigCard = $derived(!!data.campaign.cronExpression || hasRateLimit);

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
		if (isStarting || !ready) return;
		isStarting = true;
		try {
			const res = await fetch('/api/run', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ campaignId: data.campaign.id }),
			});
			const body = await res.json().catch(() => ({}));
			if (res.status === 422 && body?.error === 'not_ready') {
				const first = (body.issues as ReadinessIssue[] | undefined)?.[0];
				toast.error('Setup incomplete', {
					description: first?.title ?? 'Resolve the items in the Setup required panel.',
				});
				await invalidateAll();
				return;
			}
			if (!res.ok) throw new Error(body?.message ?? `HTTP ${res.status}`);
			const { runId, alreadyRunning } = body;
			if (alreadyRunning) {
				toast.info(`Already running - showing live log`);
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

	function handleIssueAction(issue: ReadinessIssue) {
		// In-progress issues have no action: the spinner is the affordance.
		if (issue.fix.kind === 'progress') return;
		if (issue.fix.kind === 'profile') {
			// Belt-and-braces: even if SSE hasn't refreshed yet, don't let the
			// user open the modal while a generation run is already underway.
			if (generatingProfile) {
				toast.info('Profile is already being generated', {
					description: 'Wait for the current run to finish, then regenerate if needed.',
				});
				return;
			}
			if (isDraft || (data.campaign.config && Object.keys(data.campaign.config).length === 0)) {
				regenOpen = true;
			} else {
				tab = 'profile';
			}
			return;
		}
		if ((issue.fix.kind === 'accounts' || issue.fix.kind === 'runner') && issue.fix.href) {
			window.location.assign(issue.fix.href);
		}
	}

	const lastObjective = $derived(data.skillRuns[0]?.params?.objective ?? '');
</script>

<Seo
	title={data.campaign.name}
	description="Campaign detail - cron schedule, recent runs, agent configuration."
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
	<Button
		onclick={runNow}
		size="sm"
		disabled={!ready || campaignRunning}
		loading={isStarting || campaignRunning}
		title={!ready
			? 'Resolve the setup items below first'
			: campaignRunning
				? 'A run is already in progress for this campaign'
				: undefined}
	>
		{campaignRunning ? 'Running…' : 'Run now'}
	</Button>
</header>

{#if issues.length > 0}
	{@const blocking = issues.filter((i) => i.fix.kind !== 'progress').length}
	<div class="mb-6 rounded-md border border-amber-500/40 bg-amber-500/10 p-4">
		<div class="flex items-baseline justify-between gap-3 mb-3">
			<h2 class="text-sm font-medium text-amber-700 dark:text-amber-300">
				{blocking > 0 ? 'Setup required' : 'In progress'}
			</h2>
			<span class="text-xs text-amber-700/70 dark:text-amber-300/70">
				{#if blocking > 0}
					{blocking} item{blocking === 1 ? '' : 's'} blocking this campaign
				{:else}
					An operation is running for this campaign
				{/if}
			</span>
		</div>
		<ul class="space-y-3">
			{#each issues as issue (issue.id)}
				<li class="flex items-start justify-between gap-3">
					<div class="min-w-0 flex items-start gap-2">
						{#if issue.fix.kind === 'progress'}
							<Loader2 class="size-4 animate-spin text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
						{/if}
						<div class="min-w-0">
							<p class="text-sm font-medium">{issue.title}</p>
							<p class="text-xs text-muted-foreground">{issue.hint}</p>
						</div>
					</div>
					{#if issue.fix.kind === 'progress'}
						<span
							class="shrink-0 text-xs font-mono text-amber-700/80 dark:text-amber-300/80 px-2 py-1"
						>
							{issue.fix.label}
						</span>
					{:else}
						<Button
							size="sm"
							variant="outline"
							class="shrink-0"
							onclick={() => handleIssueAction(issue)}
						>
							{issue.fix.label}
						</Button>
					{/if}
				</li>
			{/each}
		</ul>
	</div>
{/if}

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

	<div class={`grid gap-4 mb-6 ${hasConfigCard ? 'md:grid-cols-2' : ''}`}>
		{#if hasConfigCard}
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
					{#if hasRateLimit}
						<div>
							<p class="text-xs text-muted-foreground uppercase tracking-wide mb-1">Rate limit</p>
							<pre class="font-mono text-xs whitespace-pre-wrap bg-muted p-2 rounded">{JSON.stringify(
									data.campaign.rateLimit,
									null,
									2
								)}</pre>
						</div>
					{/if}
				</Card.Content>
			</Card.Root>
		{/if}

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
						<dd class="text-2xl font-semibold">{stats.successful}</dd>
					</div>
					<div>
						<dt class="text-xs text-muted-foreground">Failed</dt>
						<dd class="text-2xl font-semibold">{stats.failed}</dd>
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
{:else if tab === 'tuning'}
	<CampaignTuningTab campaignId={data.campaign.id} tuningRuns={data.tuningRuns} />
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
