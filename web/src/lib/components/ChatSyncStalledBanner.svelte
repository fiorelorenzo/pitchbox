<script lang="ts">
	import { AlertTriangle } from '@lucide/svelte';
	import { TONE_BANNER_CLASS } from '$lib/config/status-badges';

	let { show = false }: { show?: boolean } = $props();
</script>

{#if show}
	<div
		role="alert"
		class="mb-3 flex items-start gap-2 rounded-lg border {TONE_BANNER_CLASS.amber}"
	>
		<AlertTriangle class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
		<div class="flex-1">
			<div class="font-medium">Reddit Chat sync paused</div>
			<div class="text-xs text-amber-800/85 dark:text-amber-200/80">
				The browser extension's Matrix token is no longer accepted. Open
				<a
					href="https://www.reddit.com/"
					target="_blank"
					rel="noopener noreferrer"
					class="underline underline-offset-2 hover:text-amber-900 dark:hover:text-amber-100">reddit.com</a
				>
				and reload the page so the extension can capture a fresh token. New incoming chat replies will not appear until then.
			</div>
		</div>
	</div>
{/if}
