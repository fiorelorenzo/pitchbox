<script lang="ts">
	import { CheckCircle2, Circle, ArrowRight, PartyPopper, SkipForward } from '@lucide/svelte';
	import { page } from '$app/stores';
	import { goto, invalidateAll } from '$app/navigation';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import PageContainer from '$lib/components/PageContainer.svelte';
	import Seo from '$lib/components/Seo.svelte';
	import * as Card from '$lib/components/ui/card';
	import { Button } from '$lib/components/ui/button';
	import { Progress } from '$lib/components/ui/progress';
	import { TONE_TEXT_CLASS } from '$lib/config/status-badges';
	import { onboardingStepMeta, onboardingStepHref } from '$lib/onboarding-steps';
	import { t, type Locale } from '$lib/i18n/index.js';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const locale = $derived($page.data.locale as Locale);
	const applicableSteps = $derived(data.snapshot.steps.filter((s) => s.applicable));
	const doneCount = $derived(applicableSteps.filter((s) => s.complete).length);
	const totalCount = $derived(applicableSteps.length);
	const progressPct = $derived(totalCount > 0 ? Math.round((100 * doneCount) / totalCount) : 100);

	let busy = $state(false);

	async function skip() {
		busy = true;
		try {
			await fetch('/api/onboarding/skip', { method: 'POST' });
			await goto('/');
		} finally {
			busy = false;
		}
	}

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

<PageContainer size="narrow">
	<Seo
		title={t(locale, 'onboarding.page.seo-title')}
		description={t(locale, 'onboarding.page.seo-description')}
	/>

	{#if data.snapshot.status === 'in_progress'}
		<PageHeader
			title={t(locale, 'onboarding.page.seo-title')}
			description={t(locale, 'onboarding.page.header-description')}
		/>

		<div class="mb-8 flex items-center gap-3">
			<Progress
				value={progressPct}
				aria-label={t(locale, 'onboarding-banner.aria-progress')}
				class="flex-1"
			/>
			<span class="shrink-0 text-sm tabular-nums text-muted-foreground"
				>{t(locale, 'onboarding-banner.progress-count', { done: doneCount, total: totalCount })}</span
			>
		</div>

		<div class="flex flex-col gap-3">
			{#each applicableSteps as step (step.id)}
				{@const meta = onboardingStepMeta(locale, step.id)}
				{@const isCurrent = data.snapshot.currentStep === step.id}
				<Card.Root class={isCurrent ? 'border-primary/50' : undefined}>
					<Card.Content class="flex items-start gap-4 py-5">
						{#if step.complete}
							<CheckCircle2 class={`mt-0.5 size-5 shrink-0 ${TONE_TEXT_CLASS.emerald}`} aria-hidden="true" />
						{:else}
							<Circle class="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
						{/if}
						<div class="min-w-0 flex-1">
							<div class="font-medium">{meta.title}</div>
							<p class="mt-1 text-sm text-muted-foreground">{meta.description}</p>
						</div>
						<Button
							href={onboardingStepHref(step.id, { firstProjectId: data.firstProjectId })}
							variant={step.complete ? 'outline' : 'default'}
							size="sm"
							class="shrink-0"
						>
							{step.complete ? t(locale, 'onboarding.page.review-button') : meta.cta}
							<ArrowRight class="size-4" aria-hidden="true" />
						</Button>
					</Card.Content>
				</Card.Root>
			{/each}
		</div>

		<div class="mt-8 flex justify-end">
			<Button variant="ghost" size="sm" onclick={skip} disabled={busy}>
				<SkipForward class="size-4" aria-hidden="true" />
				{t(locale, 'onboarding-banner.skip')}
			</Button>
		</div>
	{:else if data.snapshot.status === 'completed'}
		<Card.Root>
			<Card.Content class="flex flex-col items-center gap-3 py-10 text-center">
				<PartyPopper class={`size-8 ${TONE_TEXT_CLASS.emerald}`} aria-hidden="true" />
				<div class="text-lg font-medium">{t(locale, 'onboarding.page.completed-title')}</div>
				<p class="max-w-sm text-sm text-muted-foreground">
					{t(locale, 'onboarding.page.completed-body')}
				</p>
				<Button href="/" class="mt-2">{t(locale, 'onboarding.page.go-to-dashboard')}</Button>
			</Card.Content>
		</Card.Root>
	{:else if data.snapshot.status === 'skipped'}
		<Card.Root>
			<Card.Content class="flex flex-col items-center gap-3 py-10 text-center">
				<div class="text-lg font-medium">{t(locale, 'onboarding.page.skipped-title')}</div>
				<p class="max-w-sm text-sm text-muted-foreground">
					{t(locale, 'onboarding.page.skipped-body')}
				</p>
				<div class="mt-2 flex gap-2">
					<Button href="/" variant="outline">{t(locale, 'onboarding.page.go-to-dashboard')}</Button>
					<Button onclick={restart} disabled={busy}>{t(locale, 'onboarding.page.start-again')}</Button>
				</div>
			</Card.Content>
		</Card.Root>
	{/if}
</PageContainer>
