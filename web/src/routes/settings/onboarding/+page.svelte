<script lang="ts">
	import { CheckCircle2, Circle } from '@lucide/svelte';
	import { page } from '$app/stores';
	import { invalidateAll } from '$app/navigation';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import Seo from '$lib/components/Seo.svelte';
	import * as Card from '$lib/components/ui/card';
	import { Button } from '$lib/components/ui/button';
	import { TONE_CLASS, TONE_TEXT_CLASS } from '$lib/config/status-badges';
	import { onboardingStepMeta } from '$lib/onboarding-steps';
	import { t, type Locale } from '$lib/i18n/index.js';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const locale = $derived($page.data.locale as Locale);
	const applicableSteps = $derived(data.snapshot.steps.filter((s) => s.applicable));

	const statusLabel = $derived(
		(
			{
				not_started: { label: t(locale, 'settings.onboarding.status.not-started'), tone: 'muted' },
				in_progress: { label: t(locale, 'settings.onboarding.status.in-progress'), tone: 'sky' },
				completed: { label: t(locale, 'settings.onboarding.status.completed'), tone: 'emerald' },
				skipped: { label: t(locale, 'settings.onboarding.status.skipped'), tone: 'slate' },
			} as Record<string, { label: string; tone: 'muted' | 'sky' | 'emerald' | 'slate' }>
		)[data.snapshot.status] ?? {
			label: t(locale, 'settings.onboarding.status.not-started'),
			tone: 'muted' as const,
		},
	);

	let busy = $state(false);

	async function restart() {
		busy = true;
		try {
			await fetch('/api/onboarding/restart', { method: 'POST' });
			await invalidateAll();
		} finally {
			busy = false;
		}
	}
</script>

<Seo
	title={t(locale, 'settings.onboarding.seo-title')}
	description={t(locale, 'settings.onboarding.seo-description')}
/>

<PageHeader
	title={t(locale, 'settings.onboarding.title')}
	description={t(locale, 'settings.onboarding.description')}
/>

<div class="flex flex-col gap-4">
		<Card.Root>
			<Card.Header>
				<div class="flex items-center justify-between gap-3">
					<Card.Title>{t(locale, 'settings.onboarding.status-label')}</Card.Title>
					<span
						class={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${TONE_CLASS[statusLabel.tone]}`}
					>
						{statusLabel.label}
					</span>
				</div>
			</Card.Header>
			<Card.Content class="flex flex-col gap-3">
				{#each applicableSteps as step (step.id)}
					<div class="flex items-center gap-3 text-sm">
						{#if step.complete}
							<CheckCircle2 class={`size-4 shrink-0 ${TONE_TEXT_CLASS.emerald}`} aria-hidden="true" />
						{:else}
							<Circle class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
						{/if}
						<span class={step.complete ? undefined : 'text-muted-foreground'}>
							{onboardingStepMeta(locale, step.id).title}
						</span>
					</div>
				{/each}
			</Card.Content>
			<Card.Footer class="flex justify-end gap-2">
				{#if data.snapshot.status === 'in_progress'}
					<Button href="/onboarding">{t(locale, 'onboarding-banner.continue-setup')}</Button>
				{:else}
					<Button onclick={restart} disabled={busy}>{t(locale, 'onboarding.page.start-again')}</Button>
				{/if}
			</Card.Footer>
		</Card.Root>
	</div>
