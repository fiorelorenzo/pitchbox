<script lang="ts">
	import { cn } from '$lib/utils.js';
	import type { Snippet } from 'svelte';
	let { class: className, children }: { class?: string; children?: Snippet } = $props();
</script>

<h2 class={cn('text-lg font-semibold', className)}>
	{@render children?.()}
</h2>
