<script lang="ts">
	import { ArrowRight, ListChecks } from '@lucide/svelte';
	import { invalidateAll } from '$app/navigation';
	import * as Card from '$lib/components/ui/card';
	import { Button } from '$lib/components/ui/button';
	import { Progress } from '$lib/components/ui/progress';
	import { ONBOARDING_STEP_META } from '$lib/onboarding-steps';
	import type { OnboardingStepId } from '@pitchbox/shared/onboarding';

	// The dashboard's entry point back into `/onboarding` while a flow is
	// `in_progress` (#516) - never rendered for `skipped`/`completed`, and
	// dismissing it here is the same server-side skip the wizard's own "Skip
	// for now" performs, not a client-only hide: reloading, or logging in
	// from another browser, must not bring it back on its own after that.
	//
	// It is built out of the same Card the dashboard's own stat cards use and
	// carries the wizard's own progress read ("2 of 5 done"), rather than
	// being a tinted info strip: this is a card of the product, not a
	// notification pasted over it, and the semantic hues stay reserved for
	// run and draft state.
	let {
		currentStep,
		done,
		total,
	}: { currentStep: OnboardingStepId | null; done: number; total: number } = $props();

	const pct = $derived(total > 0 ? Math.round((100 * done) / total) : 0);
	const meta = $derived(currentStep ? ONBOARDING_STEP_META[currentStep] : null);

	let busy = $state(false);

	async function dismiss() {
		busy = true;
		try {
			await fetch('/api/onboarding/skip', { method: 'POST' });
			await invalidateAll();
		} finally {
			busy = false;
		}
	}
</script>

<Card.Root role="region" aria-label="Setup" class="mb-6">
	<Card.Content class="flex flex-col gap-5 sm:flex-row sm:items-center sm:gap-6">
		<!-- Icon and copy are one row at every width: stacking is for the actions,
		     and an icon alone on its own line reads as a stray glyph. -->
		<div class="flex min-w-0 flex-1 items-start gap-4">
			<div
				class="bg-muted/60 ring-foreground/10 mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-md ring-1"
			>
				<ListChecks class="text-foreground/80 size-4" aria-hidden="true" />
			</div>

			<div class="min-w-0 flex-1">
				<div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
					<span class="font-medium">Finish setting up Pitchbox</span>
					<span class="text-muted-foreground text-xs tabular-nums">{done} of {total} done</span>
				</div>
				{#if meta}
					<p class="text-muted-foreground mt-1 text-sm">
						<span class="text-foreground">Next: {meta.title}.</span>
						{meta.description}
					</p>
				{/if}
			</div>
		</div>

		<div class="flex shrink-0 items-center gap-2">
			<Button href="/onboarding" size="sm">
				Continue setup
				<ArrowRight class="size-4" aria-hidden="true" />
			</Button>
			<Button variant="ghost" size="sm" onclick={dismiss} disabled={busy}>Skip for now</Button>
		</div>
	</Card.Content>

	<!-- Flush along the card's bottom edge: the one element that makes this read
	     as progress rather than as a notice. `-mb-6` cancels the card's own
	     bottom padding, and the card clips it to the rounded corners. -->
	<Progress value={pct} aria-label="Setup progress" class="-mb-6 h-1 rounded-none" />
</Card.Root>
