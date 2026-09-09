<script lang="ts">
	import { AlertTriangle, Ban } from '@lucide/svelte';
	import { TONE_BANNER_CLASS } from '$lib/config/status-badges';

	// #554: a failed payment's grace window, and the read-only state past it -
	// on every page, per the issue, so it is rendered from the root layout
	// rather than opted into per-route like ChatSyncStalledBanner/
	// ExtensionDeviceNudgeBanner. Not dismissible: an active billing problem,
	// the same posture ChatSyncStalledBanner already takes for an active-error
	// signal, unlike the soft extension nudge. `graceEndsAt` is named as an
	// actual date (`toDateString`, locale-independent so SSR and the client
	// render the same string) rather than "soon" - the issue's own acceptance
	// bar.
	let {
		billing,
	}: { billing: { graceEndsAt: string; readOnly: boolean } | null } = $props();

	const date = $derived(billing ? new Date(billing.graceEndsAt).toDateString() : '');
</script>

{#if billing}
	<div
		role="alert"
		class="mb-3 flex items-start gap-2 rounded-lg border {billing.readOnly
			? TONE_BANNER_CLASS.rose
			: TONE_BANNER_CLASS.amber}"
	>
		{#if billing.readOnly}
			<Ban class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
		{:else}
			<AlertTriangle class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
		{/if}
		<div class="flex-1">
			{#if billing.readOnly}
				<div class="font-medium">Account is read-only since {date}</div>
				<div class="text-xs text-rose-800/85 dark:text-rose-200/80">
					A payment failed and nothing succeeded during the grace period, so new runs,
					suggestions, accepts, projects, campaigns, invites and devices are refused. Everything
					already here stays readable - fix the payment method in the
					<a
						href="/settings/billing"
						class="underline underline-offset-2 hover:text-rose-900 dark:hover:text-rose-100"
						>customer portal</a
					> to restore service.
				</div>
			{:else}
				<div class="font-medium">Payment failed - grace period until {date}</div>
				<div class="text-xs text-amber-800/85 dark:text-amber-200/80">
					Your plan keeps working normally until then. Update your payment method in the
					<a
						href="/settings/billing"
						class="underline underline-offset-2 hover:text-amber-900 dark:hover:text-amber-100"
						>customer portal</a
					> before {date} to avoid the account going read-only.
				</div>
			{/if}
		</div>
	</div>
{/if}
