<script lang="ts">
	import * as Alert from '$lib/components/ui/alert';
	import * as Tooltip from '$lib/components/ui/tooltip';
	import { Info } from '@lucide/svelte';
	import { page } from '$app/stores';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import Seo from '$lib/components/Seo.svelte';
	import SettingsQuotaCard from '$lib/components/SettingsQuotaCard.svelte';
	import { Button } from '$lib/components/ui/button';
	import { toast } from 'svelte-sonner';
	import { fly } from 'svelte/transition';
	import { untrack } from 'svelte';
	import PageContainer from '$lib/components/PageContainer.svelte';
	import { t, type Locale } from '$lib/i18n/index.js';

	type QuotaWindow = { perDay: number; perWeek: number };
	type PlatformQuota = { dm: QuotaWindow; comment: QuotaWindow; post: QuotaWindow };
	type PageData = {
		quota: Record<string, PlatformQuota>;
		isAdmin: boolean;
	};

	let { data }: { data: PageData } = $props();
	const isAdmin = $derived(data.isAdmin);
	const locale = $derived($page.data.locale as Locale);

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
				toast.success(t(locale, 'settings.quota.success-saved'));
			} else if (res.status === 403) {
				toast.error(t(locale, 'settings.quota.error-admin-required'));
			} else {
				const text = await res.text();
				toast.error(t(locale, 'settings.quota.error-save-failed'), { description: text });
			}
		} finally {
			saving = false;
		}
	}

	function resetPlatform(slug: string) {
		q = { ...q, [slug]: structuredClone(DEFAULTS) };
	}
</script>

<Seo
	title={t(locale, 'settings.quota.seo-title')}
	description={t(locale, 'settings.quota.seo-description')}
/>

<Tooltip.Provider>
	<PageContainer size="default">
		<PageHeader
			title={t(locale, 'settings.quota.title')}
			description={t(locale, 'settings.quota.description')}
		/>

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
					<Alert.Title>{t(locale, 'settings.quota.admin-required-title')}</Alert.Title>
					<Alert.Description>{t(locale, 'settings.quota.admin-required-description')}</Alert.Description>
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
		<span class="text-sm">{t(locale, 'settings.quota.unsaved-changes')}</span>
		<Button variant="outline" size="sm" onclick={discard}
			>{t(locale, 'settings.quota.discard')}</Button
		>
		{#if isAdmin}
			<Button size="sm" onclick={save} disabled={saving}>{t(locale, 'settings.quota.save')}</Button>
		{/if}
	</div>
{/if}
