<script lang="ts">
	import * as Card from '$lib/components/ui/card';
	import * as Alert from '$lib/components/ui/alert';
	import { Info, Activity, Cpu } from 'lucide-svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import Seo from '$lib/components/Seo.svelte';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import ExtensionCard from '$lib/components/ExtensionCard.svelte';
	import { untrack } from 'svelte';
	import { daemonStatus } from '$lib/stores/daemon';
	import { Input } from '$lib/components/ui/input';
	import { Button } from '$lib/components/ui/button';
	import { toast } from 'svelte-sonner';

	type QuotaWindow = { perDay: number; perWeek: number };
	type RedditQuota = { dm: QuotaWindow; comment: QuotaWindow; post: QuotaWindow };
	type PageData = {
		extension: { token: string | null; createdAt: string | null; backendUrl: string };
		quota: { reddit: RedditQuota };
	};
	let { data }: { data: PageData } = $props();

	let q = $state<RedditQuota>(untrack(() => structuredClone(data.quota.reddit)));
	const DEFAULTS: RedditQuota = {
		dm: { perDay: 10, perWeek: 50 },
		comment: { perDay: 50, perWeek: 200 },
		post: { perDay: 5, perWeek: 20 },
	};

	const KIND_LABEL: Record<keyof RedditQuota, string> = {
		dm: 'DM',
		comment: 'Commenti',
		post: 'Post',
	};

	const HELP: Record<keyof RedditQuota, string> = {
		dm: 'DM diretti. Reddit non pubblica un limite ufficiale; sotto i 15/giorno è considerato a basso rischio per account con storia organica.',
		comment:
			'Somma di commenti su post + risposte ai commenti. Reddit applica throttling implicito sui nuovi account.',
		post: "Post pubblicati. Per ora la generazione di draft post non è attiva — il limite serve per un futuro caso d'uso.",
	};

	const KINDS: (keyof RedditQuota)[] = ['dm', 'comment', 'post'];

	let saving = $state(false);
	async function save() {
		saving = true;
		try {
			const res = await fetch('/api/settings/quota', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ reddit: q }),
			});
			if (res.ok) {
				toast.success('Limiti salvati');
			} else {
				const text = await res.text();
				toast.error('Salvataggio fallito', { description: text });
			}
		} finally {
			saving = false;
		}
	}

	function reset() {
		q = structuredClone(DEFAULTS);
	}

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

<div class="mt-4 max-w-4xl">
	<Card.Root>
		<Card.Header>
			<Card.Title>Quota & limiti (Reddit)</Card.Title>
		</Card.Header>
		<Card.Content class="space-y-4">
			{#each KINDS as kind}
				<div class="grid grid-cols-[120px_1fr_1fr] gap-3 items-end">
					<div class="text-sm font-medium">{KIND_LABEL[kind]}</div>
					<label class="block">
						<span class="text-xs text-muted-foreground">Per giorno</span>
						<Input type="number" min="0" bind:value={q[kind].perDay} />
					</label>
					<label class="block">
						<span class="text-xs text-muted-foreground">Per settimana</span>
						<Input type="number" min="0" bind:value={q[kind].perWeek} />
					</label>
					<p class="col-span-3 text-xs text-muted-foreground">{HELP[kind]}</p>
				</div>
			{/each}
			<div class="flex gap-2">
				<Button onclick={save} disabled={saving}>Salva</Button>
				<Button variant="outline" onclick={reset}>Ripristina default</Button>
			</div>
		</Card.Content>
	</Card.Root>
</div>
