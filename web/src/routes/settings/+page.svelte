<script lang="ts">
	import * as Card from '$lib/components/ui/card';
	import * as Alert from '$lib/components/ui/alert';
	import { Info, Activity, Cpu } from 'lucide-svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import Seo from '$lib/components/Seo.svelte';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import ExtensionCard from '$lib/components/ExtensionCard.svelte';
	import { daemonStatus } from '$lib/stores/daemon';

	type PageData = {
		extension: { token: string | null; createdAt: string | null; backendUrl: string };
	};
	let { data }: { data: PageData } = $props();

	function formatAge(seconds: number): string {
		if (seconds < 60) return `${seconds}s ago`;
		if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
		return `${Math.floor(seconds / 3600)}h ago`;
	}
</script>

<Seo title="Settings" description="Daemon status, agent runner, and extension configuration." />

<PageHeader
	title="Settings"
	description="Daemon status, agent runner configuration, and browser extension hookup."
/>

<div class="grid grid-cols-1 lg:grid-cols-2 gap-4 max-w-4xl">
	<Card.Root size="sm">
		<Card.Header class="flex flex-row flex-nowrap items-center gap-2 space-y-0">
			<Activity class="size-4 shrink-0 text-muted-foreground" />
			<Card.Title class="text-base min-w-0 flex-1 truncate">Daemon</Card.Title>
			<StatusBadge
				class="shrink-0"
				domain="daemon-status"
				value={$daemonStatus.loading ? 'checking' : $daemonStatus.alive ? 'online' : 'offline'}
			/>
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

	<Card.Root size="sm">
		<Card.Header class="flex flex-row flex-nowrap items-center gap-2 space-y-0">
			<Cpu class="size-4 shrink-0 text-muted-foreground" />
			<Card.Title class="text-base min-w-0 flex-1 truncate">Agent runner</Card.Title>
			<code class="shrink-0 rounded border bg-muted px-1.5 py-[1px] font-mono text-[10px]">
				claude-code
			</code>
		</Card.Header>
		<Card.Content>
			<p class="text-xs text-muted-foreground">
				Each campaign locks its runner at creation time, and each run snapshots the runner it used.
				Per-campaign overrides plus codex/opencode adapters ship in the next milestones.
			</p>
		</Card.Content>
	</Card.Root>

	<ExtensionCard
		token={data.extension.token}
		createdAt={data.extension.createdAt}
		backendUrl={data.extension.backendUrl}
	/>
</div>
