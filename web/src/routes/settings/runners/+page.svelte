<script lang="ts">
	import * as Alert from '$lib/components/ui/alert';
	import { Info } from '@lucide/svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import Seo from '$lib/components/Seo.svelte';
	import SettingsRunnersCard from '$lib/components/SettingsRunnersCard.svelte';
	import PageContainer from '$lib/components/PageContainer.svelte';
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
	const isAdmin = $derived(data.isAdmin);

	let runners = $state(untrack(() => data.runners));
	let defaultRunner = $state(untrack(() => data.defaultRunner));
</script>

<Seo title="Settings - Agent runners" description="Agent runner detection and configuration." />

<PageContainer size="default">
	<PageHeader title="Agent runners" description="Detected agent runners, their configuration, and the org default." />

	<div class="max-w-3xl">
		{#if isAdmin}
			<SettingsRunnersCard bind:runners bind:defaultRunner {isAdmin} />
		{:else}
			<Alert.Root>
				<Info class="size-4" />
				<Alert.Title>Admin access required</Alert.Title>
				<Alert.Description>
					Runner configuration is visible to org admins and owners. Ask an admin if you need to
					check runner availability.
				</Alert.Description>
			</Alert.Root>
		{/if}
	</div>
</PageContainer>
