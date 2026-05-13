<script lang="ts">
	import { cn } from '$lib/utils.js';
	import type { Snippet } from 'svelte';
	let { class: className, children }: { class?: string; children?: Snippet } = $props();
</script>

<div class={cn('flex flex-col gap-1.5', className)}>
	{@render children?.()}
</div>
