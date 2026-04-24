<script lang="ts">
	import { slide } from 'svelte/transition';

	let { data }: { data: { text: string } } = $props();

	const TRUNCATE_AT = 400;

	let expanded = $state(false);
	let isLong = $derived(data.text.length > TRUNCATE_AT);
	let displayText = $derived(
		isLong && !expanded ? data.text.slice(0, TRUNCATE_AT).trimEnd() + '…' : data.text,
	);
</script>

<div class="mt-1 min-w-0">
	<p class="text-sm whitespace-pre-wrap break-words leading-relaxed text-foreground/90 min-w-0">
		{displayText}
	</p>
	{#if isLong}
		<button
			onclick={() => (expanded = !expanded)}
			class="mt-1 text-xs text-muted-foreground hover:text-foreground underline-offset-2 hover:underline"
		>
			{expanded ? 'Show less' : 'Show more'}
		</button>
	{/if}
</div>
