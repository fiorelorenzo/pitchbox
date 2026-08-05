<script lang="ts">
	import PageHeader from '$lib/components/PageHeader.svelte';
	import Seo from '$lib/components/Seo.svelte';
	import ExtensionCard from '$lib/components/ExtensionCard.svelte';
	import ExtensionDevices from '$lib/components/ExtensionDevices.svelte';
	import PageContainer from '$lib/components/PageContainer.svelte';

	type PageData = {
		extension: { backendUrl: string };
		isAdmin: boolean;
	};

	let { data }: { data: PageData } = $props();
	const isAdmin = $derived(data.isAdmin);
</script>

<Seo title="Settings - Browser extension" description="Pair and manage the Pitchbox browser extension." />

<PageContainer size="default">
	<PageHeader title="Browser extension" description="Pair the Pitchbox Chrome extension with this dashboard and manage paired devices." />

	<div class="max-w-2xl flex flex-col gap-4">
		<ExtensionCard backendUrl={data.extension.backendUrl} />
		<ExtensionDevices {isAdmin} />
	</div>
</PageContainer>
