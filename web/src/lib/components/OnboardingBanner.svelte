<script lang="ts">
	import { ListChecks, X } from '@lucide/svelte';
	import { goto, invalidateAll } from '$app/navigation';
	import { TONE_BANNER_CLASS, TONE_TEXT_CLASS } from '$lib/config/status-badges';
	import { ONBOARDING_STEP_META } from '$lib/onboarding-steps';
	import type { OnboardingStepId } from '@pitchbox/shared/onboarding';

	// The dashboard's entry point back into `/onboarding` while a flow is
	// `in_progress` (#516) - never rendered for `skipped`/`completed`, and
	// dismissing it here is the same server-side skip the wizard's own "Skip
	// for now" performs, not a client-only hide: reloading, or logging in
	// from another browser, must not bring it back on its own after that.
	let { currentStep }: { currentStep: OnboardingStepId | null } = $props();

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

	function continueSetup() {
		goto('/onboarding');
	}
</script>

<div role="alert" class={`mb-3 flex items-start gap-2 rounded-lg border ${TONE_BANNER_CLASS.sky}`}>
	<ListChecks class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
	<div class="flex-1">
		<div class="font-medium">Finish setting up Pitchbox</div>
		<div class="text-xs text-sky-800/85 dark:text-sky-200/80">
			{#if currentStep}
				Next: {ONBOARDING_STEP_META[currentStep].title}.
			{/if}
			<button
				type="button"
				onclick={continueSetup}
				class={`underline underline-offset-2 hover:text-sky-900 dark:hover:text-sky-100`}
			>
				Continue setup
			</button>
		</div>
	</div>
	<button
		type="button"
		onclick={dismiss}
		disabled={busy}
		aria-label="Dismiss"
		class={`shrink-0 rounded p-0.5 ${TONE_TEXT_CLASS.sky} hover:bg-sky-500/20 hover:text-sky-900 dark:hover:text-sky-100`}
	>
		<X class="size-3.5" aria-hidden="true" />
	</button>
</div>
