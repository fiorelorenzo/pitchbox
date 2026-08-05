<script lang="ts">
	import * as Alert from '$lib/components/ui/alert';
	import * as Tooltip from '$lib/components/ui/tooltip';
	import { Info } from '@lucide/svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import Seo from '$lib/components/Seo.svelte';
	import SettingsQuotaCard from '$lib/components/SettingsQuotaCard.svelte';
	import { Button } from '$lib/components/ui/button';
	import { toast } from 'svelte-sonner';
	import { fly } from 'svelte/transition';
	import { untrack } from 'svelte';
	import PageContainer from '$lib/components/PageContainer.svelte';

	type QuotaWindow = { perDay: number; perWeek: number };
	type PlatformQuota = { dm: QuotaWindow; comment: QuotaWindow; post: QuotaWindow };
	type PageData = {
		quota: Record<string, PlatformQuota>;
		isAdmin: boolean;
	};

	let { data }: { data: PageData } = $props();
	const isAdmin = $derived(data.isAdmin);

	const DEFAULTS: PlatformQuota = {
		dm: { perDay: 10, perWeek: 50 },
		comment: { perDay: 50, perWeek: 200 },
		post: { perDay: 5, perWeek: 20 },
	};

	// Dirty-tracking state - untrack to silence state_referenced_locally.
	let initial = $state(untrack(() => structuredClone(data.quota)));
	let q = $state(untrack(() => structuredClone(data.quota)));
	const dirty = $derived(JSON.stringify(q) !== JSON.stringify(initial));

	let saving = $state(false);

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
			} else if (res.status === 403) {
				toast.error('You need admin access for that');
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
</script>

<Seo title="Settings - Quota" description="Posting quota defaults per platform." />

<Tooltip.Provider>
	<PageContainer size="default">
		<PageHeader title="Quota" description="Default posting limits per platform, per day and per week." />

		<div class="max-w-2xl flex flex-col gap-4">
			{#if isAdmin}
				{#each Object.entries(q) as [slug] (slug)}
					<SettingsQuotaCard
						{slug}
						bind:limits={q[slug]}
						defaults={DEFAULTS}
						onreset={() => resetPlatform(slug)}
					/>
				{/each}
			{:else}
				<Alert.Root>
					<Info class="size-4" />
					<Alert.Title>Admin access required</Alert.Title>
					<Alert.Description>Posting quotas are visible to org admins and owners.</Alert.Description>
				</Alert.Root>
			{/if}
		</div>
	</PageContainer>
</Tooltip.Provider>

{#if dirty}
	<div
		class="fixed bottom-4 left-1/2 -translate-x-1/2 z-40 flex items-center gap-3 rounded-lg border bg-background px-4 py-2 shadow-lg"
		transition:fly={{ y: 20, duration: 150 }}
	>
		<span class="text-sm">You have unsaved changes</span>
		<Button variant="outline" size="sm" onclick={discard}>Discard</Button>
		{#if isAdmin}
			<Button size="sm" onclick={save} disabled={saving}>Save</Button>
		{/if}
	</div>
{/if}
