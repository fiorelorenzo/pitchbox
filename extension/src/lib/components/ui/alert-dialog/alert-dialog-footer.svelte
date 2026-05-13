<script lang="ts">
	import { cn } from '$lib/utils.js';
	import type { Snippet } from 'svelte';
	let { class: className, children }: { class?: string; children?: Snippet } = $props();
</script>

<div class={cn('flex flex-col-reverse sm:flex-row sm:justify-end gap-2', className)}>
	{@render children?.()}
</div>
