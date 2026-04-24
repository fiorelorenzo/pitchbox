<script lang="ts">
	import * as Card from '$lib/components/ui/card';
	import * as Alert from '$lib/components/ui/alert';
	import { Badge } from '$lib/components/ui/badge';
	import { Info, Activity, Cpu, Terminal } from 'lucide-svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import { daemonStatus } from '$lib/stores/daemon';

	function formatAge(seconds: number): string {
		if (seconds < 60) return `${seconds}s ago`;
		if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
		return `${Math.floor(seconds / 3600)}h ago`;
	}
</script>

<PageHeader
	title="Settings"
	description="Daemon status, agent runner configuration, and browser extension hookup."
/>

<div class="grid grid-cols-1 lg:grid-cols-2 gap-4 max-w-4xl">
	<Card.Root>
		<Card.Header class="flex-row items-center justify-between space-y-0 pb-3">
			<div class="flex items-center gap-2">
				<Activity class="size-4 text-muted-foreground" />
				<Card.Title class="text-base">Daemon</Card.Title>
			</div>
			{#if $daemonStatus.loading}
				<Badge variant="secondary" class="text-[10px]">checking…</Badge>
			{:else if $daemonStatus.alive}
				<Badge class="text-[10px] bg-emerald-500/90 hover:bg-emerald-500/90">online</Badge>
			{:else}
				<Badge variant="destructive" class="text-[10px]">offline</Badge>
			{/if}
		</Card.Header>
		<Card.Content class="flex flex-col gap-3">
			<p class="text-xs text-muted-foreground">
				The daemon wakes up on schedule, triggers campaigns that have a cron expression, and polls
				sent DMs for replies.
			</p>
			{#if $daemonStatus.modules.length === 0 && !$daemonStatus.loading}
				<Alert.Root>
					<Info class="size-4" />
					<Alert.Title>Not running</Alert.Title>
					<Alert.Description>
						Start it from the repo root with
						<code class="text-xs font-mono">npm run -w daemon dev</code>.
					</Alert.Description>
				</Alert.Root>
			{:else}
				<ul class="flex flex-col gap-2">
					{#each $daemonStatus.modules as m (m.module)}
						<li class="flex items-center gap-2 text-sm">
							<span
								class="size-2 rounded-full shrink-0 {m.alive
									? 'bg-emerald-400'
									: 'bg-muted-foreground/40'}"
							></span>
							<span class="font-mono text-xs">{m.module}</span>
							<span class="text-xs text-muted-foreground ml-auto">
								{formatAge(m.ageSeconds)}
							</span>
						</li>
					{/each}
				</ul>
			{/if}
		</Card.Content>
	</Card.Root>

	<Card.Root>
		<Card.Header class="flex-row items-center gap-2 pb-3">
			<Cpu class="size-4 text-muted-foreground" />
			<Card.Title class="text-base">Agent runner</Card.Title>
		</Card.Header>
		<Card.Content>
			<p class="text-sm">
				Default: <code class="text-xs font-mono">claude-code</code>
			</p>
			<p class="text-xs text-muted-foreground mt-1">
				Each campaign locks its runner at creation time, and each run snapshots the runner it used.
				Per-campaign overrides plus codex/opencode adapters ship in the next milestones.
			</p>
		</Card.Content>
	</Card.Root>

	<Card.Root>
		<Card.Header class="flex-row items-center gap-2 pb-3">
			<Terminal class="size-4 text-muted-foreground" />
			<Card.Title class="text-base">Browser extension</Card.Title>
		</Card.Header>
		<Card.Content>
			<Alert.Root>
				<Info class="size-4" />
				<Alert.Title>Not yet shipped</Alert.Title>
				<Alert.Description>
					Will auto-mark drafts as sent and sync DM reply state back into the dashboard.
				</Alert.Description>
			</Alert.Root>
		</Card.Content>
	</Card.Root>
</div>
