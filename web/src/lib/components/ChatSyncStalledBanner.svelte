<script lang="ts">
	import { AlertTriangle } from '@lucide/svelte';
	import { page } from '$app/stores';
	import { TONE_BANNER_CLASS } from '$lib/config/status-badges';
	import { t, splitAroundToken, type Locale } from '$lib/i18n/index.js';

	let { show = false }: { show?: boolean } = $props();

	const locale = $derived($page.data.locale as Locale);
	const [before, after] = $derived(splitAroundToken(locale, 'chat-sync-banner.body', 'link'));
</script>

{#if show}
	<div
		role="alert"
		class="mb-3 flex items-start gap-2 rounded-lg border {TONE_BANNER_CLASS.amber}"
	>
		<AlertTriangle class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
		<div class="flex-1">
			<div class="font-medium">{t(locale, 'chat-sync-banner.title')}</div>
			<div class="text-xs text-amber-800/85 dark:text-amber-200/80">
				{before}<a
					href="https://www.reddit.com/"
					target="_blank"
					rel="noopener noreferrer"
					class="underline underline-offset-2 hover:text-amber-900 dark:hover:text-amber-100">reddit.com</a
				>{after}
			</div>
		</div>
	</div>
{/if}
