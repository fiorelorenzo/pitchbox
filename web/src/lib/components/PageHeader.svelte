<script lang="ts">
	import type { Snippet } from 'svelte';

	let {
		title,
		description,
		actions,
	}: {
		title: string;
		description?: string;
		actions?: Snippet;
	} = $props();
</script>

<header class="mb-6 flex items-start justify-between gap-4">
	<div class="min-w-0">
		<h1 class="text-2xl font-semibold tracking-tight">{title}</h1>
		{#if description}
			<p class="mt-1 text-sm text-muted-foreground">{description}</p>
		{/if}
	</div>
	{#if actions}
		<div class="shrink-0 flex items-center gap-2">
			{@render actions()}
		</div>
	{/if}
</header>
