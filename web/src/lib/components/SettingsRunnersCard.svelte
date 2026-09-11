<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import { RefreshCw, Inbox } from '@lucide/svelte';
	import { toast } from 'svelte-sonner';
	import { page } from '$app/stores';
	import { t, type Locale } from '$lib/i18n/index.js';
	import RunnerCard from '$lib/components/RunnerCard.svelte';

	const locale = $derived($page.data.locale as Locale);

	type RunnerConfig = {
		model?: string;
		maxTurns?: number;
		extraArgs?: string[];
	};

	type Runner = {
		slug: string;
		label: string;
		implemented: boolean;
		available: boolean;
		version: string | null;
		path: string | null;
		error: string | null;
		detectedAt: string;
		config: RunnerConfig;
	};

	let {
		runners = $bindable(),
		defaultRunner = $bindable(),
		isAdmin,
	}: {
		runners: Runner[];
		defaultRunner: string | null;
		isAdmin: boolean;
	} = $props();

	let detecting = $state(false);

	async function redetect() {
		if (detecting) return;
		detecting = true;
		try {
			const res = await fetch('/api/runners', { method: 'POST' });
			if (!res.ok) {
				toast.error(
					res.status === 403
						? t(locale, 'settings.runners.card.error-admin-required')
						: t(locale, 'settings.runners.card.error-redetect-failed'),
				);
				return;
			}
			const body = await res.json();
			runners = body.runners.map((r: Omit<Runner, 'config'>) => ({
				...r,
				config: runners.find((cur) => cur.slug === r.slug)?.config ?? {},
			}));
			toast.success(t(locale, 'settings.runners.card.success-redetected'));
		} finally {
			detecting = false;
		}
	}

	async function setDefault(slug: string) {
		const res = await fetch('/api/settings/default-runner', {
			method: 'PUT',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ slug }),
		});
		if (!res.ok) {
			toast.error(
				res.status === 403
					? t(locale, 'settings.runners.card.error-admin-required')
					: t(locale, 'settings.runners.card.error-set-default-failed'),
			);
			return;
		}
		defaultRunner = slug;
		toast.success(t(locale, 'settings.runners.card.success-set-default', { slug }));
	}

	const usable = $derived(runners.filter((r) => r.implemented && r.available));
	const planned = $derived(runners.filter((r) => !r.implemented || !r.available));
</script>

<section class="flex flex-col gap-3">
	<header class="flex items-start justify-between gap-2">
		<div>
			<h2 class="text-base font-semibold">{t(locale, 'settings.runners.title')}</h2>
			<p class="text-xs text-muted-foreground">
				{t(locale, 'settings.runners.card.description')}
			</p>
		</div>
		{#if isAdmin}
			<Button variant="outline" size="sm" onclick={redetect} disabled={detecting}>
				<RefreshCw class="size-3 {detecting ? 'animate-spin' : ''}" />
				{t(locale, 'settings.runners.card.redetect')}
			</Button>
		{/if}
	</header>

	{#if usable.length === 0}
		<div class="rounded-md border border-dashed border-border/60 px-4 py-6 text-center">
			<Inbox class="mx-auto size-6 text-muted-foreground" />
			<p class="mt-2 text-sm font-medium">{t(locale, 'settings.runners.card.empty-title')}</p>
			<p class="mt-1 text-xs text-muted-foreground">
				{t(locale, 'settings.runners.card.empty-install-lead')}
				<code class="rounded bg-muted px-1.5 py-0.5">claude</code>
				{t(locale, 'settings.runners.card.empty-install-tail')}
				<em>{t(locale, 'settings.runners.card.redetect')}</em>.
			</p>
		</div>
	{:else}
		<div class="grid grid-cols-1 gap-3">
			{#each usable as r, i (r.slug)}
				<RunnerCard
					bind:runner={runners[runners.indexOf(r)]}
					isDefault={defaultRunner === r.slug || (defaultRunner === null && i === 0)}
					onSetDefault={() => setDefault(r.slug)}
					{isAdmin}
				/>
			{/each}
		</div>
	{/if}

	{#if planned.length > 0}
		<div class="grid grid-cols-1 gap-3 opacity-70">
			{#each planned as r (r.slug)}
				<RunnerCard
					bind:runner={runners[runners.indexOf(r)]}
					isDefault={false}
					onSetDefault={() => {}}
					{isAdmin}
				/>
			{/each}
		</div>
	{/if}
</section>
