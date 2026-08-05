<script lang="ts">
	import type { Snippet } from 'svelte';
	import { cn } from '$lib/utils';

	const SIZE_CLASS = {
		narrow: 'max-w-2xl',
		default: 'max-w-6xl',
		wide: 'max-w-screen-2xl',
		full: '',
	} as const;

	let {
		size = 'default',
		class: className,
		children,
	}: {
		size?: 'narrow' | 'default' | 'wide' | 'full';
		class?: string;
		children: Snippet;
	} = $props();
</script>

<div class={cn('mx-auto w-full', SIZE_CLASS[size], className)}>
	{@render children()}
</div>
