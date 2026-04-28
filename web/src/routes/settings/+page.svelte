<script lang="ts">
	import * as Card from '$lib/components/ui/card';
	import * as Alert from '$lib/components/ui/alert';
	import * as Tabs from '$lib/components/ui/tabs';
	import * as Tooltip from '$lib/components/ui/tooltip';
	import { Info, Activity, Cpu } from 'lucide-svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import Seo from '$lib/components/Seo.svelte';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import ExtensionCard from '$lib/components/ExtensionCard.svelte';
	import SettingsQuotaCard from '$lib/components/SettingsQuotaCard.svelte';
	import { daemonStatus } from '$lib/stores/daemon';
	import { Button } from '$lib/components/ui/button';
	import { toast } from 'svelte-sonner';
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import { fly } from 'svelte/transition';
	import { untrack } from 'svelte';

	type QuotaWindow = { perDay: number; perWeek: number };
	type PlatformQuota = { dm: QuotaWindow; comment: QuotaWindow; post: QuotaWindow };
	type PageData = {
		extension: { token: string | null; createdAt: string | null; backendUrl: string };
		quota: Record<string, PlatformQuota>;
	};

	let { data }: { data: PageData } = $props();

	const DEFAULTS: PlatformQuota = {
		dm: { perDay: 10, perWeek: 50 },
		comment: { perDay: 50, perWeek: 200 },
		post: { perDay: 5, perWeek: 20 },
	};

	// Quota dirty-tracking state — untrack to silence state_referenced_locally
	let initial = $state(untrack(() => structuredClone(data.quota)));
	let q = $state(untrack(() => structuredClone(data.quota)));
	const dirty = $derived(JSON.stringify(q) !== JSON.stringify(initial));

	let saving = $state(false);

	// Tab state — driven by URL ?tab=
	const VALID_TABS = ['status', 'integrations', 'quota'] as const;
	type TabValue = (typeof VALID_TABS)[number];

	let activeTab = $state<TabValue>('status');

	// Sync activeTab from URL on navigation
	$effect(() => {
		const tabParam = $page.url.searchParams.get('tab');
		if (tabParam && (VALID_TABS as readonly string[]).includes(tabParam)) {
			activeTab = tabParam as TabValue;
		} else {
			activeTab = 'status';
		}
	});

	function onTabChange(value: string) {
		activeTab = value as TabValue;
		const url = new URL($page.url);
		if (value === 'status') {
			url.searchParams.delete('tab');
		} else {
			url.searchParams.set('tab', value);
		}
		goto(url.pathname + url.search, { replaceState: true });
	}

	function discard() {
		q = structuredClone(initial);
	}

	async function save() {
		saving = true;
		try {
			const res = await fetch('/api/settings/quota', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(q),
			});
			if (res.ok) {
				initial = structuredClone(q);
				toast.success('Limits saved');
			} else {
				const text = await res.text();
				toast.error('Save failed', { description: text });
			}
		} finally {
			saving = false;
		}
	}

	function resetPlatform(slug: string) {
		q = { ...q, [slug]: structuredClone(DEFAULTS) };
	}

	function formatAge(seconds: number): string {
		if (seconds < 60) return `${seconds}s ago`;
		if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
		return `${Math.floor(seconds / 3600)}h ago`;
	}
</script>

<Seo title="Settings" description="Daemon status, agent runner, and extension configuration." />

<Tooltip.Provider>
	<PageHeader
		title="Settings"
		description="Daemon status, agent runner configuration, and browser extension hookup."
	/>

	<Tabs.Root value={activeTab} onValueChange={onTabChange} class="mt-2">
		<Tabs.List variant="line">
			<Tabs.Trigger value="status">Status</Tabs.Trigger>
			<Tabs.Trigger value="integrations">Integrations</Tabs.Trigger>
			<Tabs.Trigger value="quota">Quota</Tabs.Trigger>
		</Tabs.List>

		<!-- Status tab -->
		<Tabs.Content value="status" class="mt-4">
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
							The daemon wakes up on schedule, triggers campaigns that have a cron expression, and
							polls sent DMs for replies.
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
							Each campaign locks its runner at creation time, and each run snapshots the runner it
							used. Per-campaign overrides plus codex/opencode adapters ship in the next milestones.
						</p>
					</Card.Content>
				</Card.Root>
			</div>
		</Tabs.Content>

		<!-- Integrations tab -->
		<Tabs.Content value="integrations" class="mt-4">
			<div class="max-w-2xl">
				<ExtensionCard
					token={data.extension.token}
					createdAt={data.extension.createdAt}
					backendUrl={data.extension.backendUrl}
				/>
			</div>
		</Tabs.Content>

		<!-- Quota tab -->
		<Tabs.Content value="quota" class="mt-4">
			<div class="max-w-2xl flex flex-col gap-4">
				{#each Object.entries(q) as [slug] (slug)}
					<SettingsQuotaCard
						{slug}
						bind:limits={q[slug]}
						defaults={DEFAULTS}
						onreset={() => resetPlatform(slug)}
					/>
				{/each}
			</div>
		</Tabs.Content>
	</Tabs.Root>

	<!-- Sticky save bar — only on quota tab when dirty -->
	{#if activeTab === 'quota' && dirty}
		<div
			class="fixed bottom-4 left-1/2 -translate-x-1/2 z-40 flex items-center gap-3 rounded-lg border bg-background px-4 py-2 shadow-lg"
			transition:fly={{ y: 20, duration: 150 }}
		>
			<span class="text-sm">You have unsaved changes</span>
			<Button variant="outline" size="sm" onclick={discard}>Discard</Button>
			<Button size="sm" onclick={save} disabled={saving}>Save</Button>
		</div>
	{/if}
</Tooltip.Provider>
