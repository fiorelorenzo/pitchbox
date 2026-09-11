<script lang="ts">
	import { page } from '$app/stores';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import Seo from '$lib/components/Seo.svelte';
	import ExtensionCard from '$lib/components/ExtensionCard.svelte';
	import ExtensionDevices from '$lib/components/ExtensionDevices.svelte';
	import { t, type Locale } from '$lib/i18n/index.js';

	type PageData = {
		extension: { backendUrl: string };
		isAdmin: boolean;
	};

	let { data }: { data: PageData } = $props();
	const isAdmin = $derived(data.isAdmin);
	const locale = $derived($page.data.locale as Locale);
</script>

<Seo
	title={t(locale, 'settings.extension.seo-title')}
	description={t(locale, 'settings.extension.seo-description')}
/>

<PageHeader
	title={t(locale, 'settings.extension.title')}
	description={t(locale, 'settings.extension.description')}
/>

<div class="flex flex-col gap-4">
	<ExtensionCard backendUrl={data.extension.backendUrl} />
	<ExtensionDevices {isAdmin} />
</div>
