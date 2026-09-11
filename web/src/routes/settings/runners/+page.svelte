<script lang="ts">
	import * as Alert from '$lib/components/ui/alert';
	import { Info } from '@lucide/svelte';
	import { page } from '$app/stores';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import Seo from '$lib/components/Seo.svelte';
	import SettingsRunnersCard from '$lib/components/SettingsRunnersCard.svelte';
	import { t, type Locale } from '$lib/i18n/index.js';
	import { untrack } from 'svelte';

	type RunnerInfo = {
		slug: string;
		label: string;
		implemented: boolean;
		available: boolean;
		version: string | null;
		path: string | null;
		error: string | null;
		detectedAt: string;
		config: { model?: string; maxTurns?: number; extraArgs?: string[] };
	};
	type PageData = {
		runners: RunnerInfo[];
		defaultRunner: string | null;
		isAdmin: boolean;
	};

	let { data }: { data: PageData } = $props();
	const locale = $derived($page.data.locale as Locale);
	const isAdmin = $derived(data.isAdmin);

	let runners = $state(untrack(() => data.runners));
	let defaultRunner = $state(untrack(() => data.defaultRunner));
</script>

<Seo
	title={t(locale, 'settings.runners.seo-title')}
	description={t(locale, 'settings.runners.seo-description')}
/>

<PageHeader
	title={t(locale, 'settings.runners.title')}
	description={t(locale, 'settings.runners.description')}
/>

<div>
		{#if isAdmin}
			<SettingsRunnersCard bind:runners bind:defaultRunner {isAdmin} />
		{:else}
			<Alert.Root>
				<Info class="size-4" />
				<Alert.Title>{t(locale, 'settings.runners.admin-required-title')}</Alert.Title>
				<Alert.Description>
					{t(locale, 'settings.runners.admin-required-description')}
				</Alert.Description>
			</Alert.Root>
		{/if}
	</div>
