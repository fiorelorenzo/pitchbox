<script lang="ts">
	import { CheckCircle2, Circle } from '@lucide/svelte';
	import { invalidateAll } from '$app/navigation';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import PageContainer from '$lib/components/PageContainer.svelte';
	import Seo from '$lib/components/Seo.svelte';
	import * as Card from '$lib/components/ui/card';
	import { Button } from '$lib/components/ui/button';
	import { TONE_CLASS, TONE_TEXT_CLASS } from '$lib/config/status-badges';
	import { ONBOARDING_STEP_META } from '$lib/onboarding-steps';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const applicableSteps = $derived(data.snapshot.steps.filter((s) => s.applicable));

	const STATUS_LABEL: Record<string, { label: string; tone: 'muted' | 'sky' | 'emerald' | 'slate' }> = {
		not_started: { label: 'Not started', tone: 'muted' },
		in_progress: { label: 'In progress', tone: 'sky' },
		completed: { label: 'Completed', tone: 'emerald' },
		skipped: { label: 'Skipped', tone: 'slate' },
	};
	const status = $derived(STATUS_LABEL[data.snapshot.status] ?? STATUS_LABEL.not_started);

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

<PageContainer size="default">
	<Seo title="Settings - Onboarding" description="The guided first-run setup: its status, and starting it again." />

	<PageHeader title="Onboarding" description="The guided setup that ran on first sign-in." />

	<div class="mt-4 flex flex-col gap-4">
		<Card.Root>
			<Card.Header>
				<div class="flex items-center justify-between gap-3">
					<Card.Title>Status</Card.Title>
					<span
						class={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${TONE_CLASS[status.tone]}`}
					>
						{status.label}
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
							{ONBOARDING_STEP_META[step.id].title}
						</span>
					</div>
				{/each}
			</Card.Content>
			<Card.Footer class="flex justify-end gap-2">
				{#if data.snapshot.status === 'in_progress'}
					<Button href="/onboarding">Continue setup</Button>
				{:else}
					<Button onclick={restart} disabled={busy}>Start setup again</Button>
				{/if}
			</Card.Footer>
		</Card.Root>
	</div>
</PageContainer>
