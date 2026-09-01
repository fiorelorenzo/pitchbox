<script lang="ts">
	import * as Card from '$lib/components/ui/card';
	import * as Alert from '$lib/components/ui/alert';
	import { Info, Activity } from '@lucide/svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import Seo from '$lib/components/Seo.svelte';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import SettingsAppearanceCard from '$lib/components/SettingsAppearanceCard.svelte';
	import { daemonStatus } from '$lib/stores/daemon';
	import { PULSE_DOT_CLASS } from '$lib/config/status-badges';
	import PageContainer from '$lib/components/PageContainer.svelte';

	function formatAge(seconds: number): string {
		if (seconds < 60) return `${seconds}s ago`;
		if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
		return `${Math.floor(seconds / 3600)}h ago`;
	}
</script>

<Seo title="Settings - Status" description="Daemon status and dashboard appearance." />

<PageContainer size="default">
	<PageHeader title="Status" description="Daemon health and dashboard appearance." />

	<div class="grid grid-cols-1 lg:grid-cols-2 gap-4 max-w-4xl">
		<Card.Root size="sm">
			<Card.Header class="flex flex-row flex-nowrap items-center gap-2 space-y-0">
				<Activity class="size-4 shrink-0 text-muted-foreground" />
				<Card.Title class="text-base min-w-0 flex-1 truncate">Daemon</Card.Title>
				<StatusBadge
					class="shrink-0"
					domain="daemon-status"
					value={$daemonStatus.loading
						? 'checking'
						: !$daemonStatus.reachable
							? 'unknown'
							: $daemonStatus.alive
								? 'online'
								: 'offline'}
				/>
			</Card.Header>
			<Card.Content class="flex flex-col gap-3">
				<p class="text-xs text-muted-foreground">
					The daemon wakes up on schedule, triggers campaigns that have a cron expression, and
					polls sent DMs for replies.
				</p>
				{#if !$daemonStatus.reachable && !$daemonStatus.loading}
					<Alert.Root>
						<Info class="size-4" />
						<Alert.Title>Status unavailable</Alert.Title>
						<Alert.Description>
							The status endpoint could not be read, so this says nothing about the daemon
							itself. If your session expired, sign in again and reload.
						</Alert.Description>
					</Alert.Root>
				{:else if $daemonStatus.modules.length === 0 && !$daemonStatus.loading}
					<Alert.Root>
						<Info class="size-4" />
						<Alert.Title>Not running</Alert.Title>
						<Alert.Description>
							Start it from the repo root with
							<code class="text-xs font-mono">pnpm -F daemon dev</code>.
						</Alert.Description>
					</Alert.Root>
				{:else}
					<ul class="flex flex-col gap-2">
						{#each $daemonStatus.modules as m (m.module)}
							<li class="flex items-center gap-2 text-sm">
								<span
									class="size-2 rounded-full shrink-0 {m.alive
										? PULSE_DOT_CLASS.emerald
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

		<SettingsAppearanceCard />
	</div>
</PageContainer>
