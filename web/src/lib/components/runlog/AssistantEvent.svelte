<script lang="ts">
	import { page } from '$app/stores';
	import Markdown from '$lib/components/Markdown.svelte';
	import { t, type Locale } from '$lib/i18n/index.js';

	let { data }: { data: { text: string } } = $props();

	const locale = $derived($page.data.locale as Locale);

	const TRUNCATE_AT = 400;

	let expanded = $state(false);
	let isLong = $derived(data.text.length > TRUNCATE_AT);
	let displayText = $derived(
		isLong && !expanded ? data.text.slice(0, TRUNCATE_AT).trimEnd() + '…' : data.text,
	);
</script>

<div class="mt-1 min-w-0 max-w-full break-words">
	<Markdown source={displayText} class="text-foreground/90 leading-relaxed break-words" />
	{#if isLong}
		<button
			onclick={() => (expanded = !expanded)}
			class="mt-1 text-xs text-muted-foreground hover:text-foreground underline-offset-2 hover:underline cursor-pointer"
		>
			{expanded ? t(locale, 'runlog.show-less') : t(locale, 'runlog.show-more')}
		</button>
	{/if}
</div>
