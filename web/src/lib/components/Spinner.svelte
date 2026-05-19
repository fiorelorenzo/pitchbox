<script lang="ts">
	import { cn } from '$lib/utils';

	type Props = {
		size?: 'xs' | 'sm' | 'md' | 'lg';
		class?: string;
		// Accessible label rendered as sr-only text. Defaults to "Loading".
		label?: string;
	};

	let { size = 'sm', class: className, label = 'Loading' }: Props = $props();

	const SIZE: Record<NonNullable<Props['size']>, string> = {
		xs: 'size-3',
		sm: 'size-4',
		md: 'size-5',
		lg: 'size-6',
	};
	const STROKE: Record<NonNullable<Props['size']>, string> = {
		xs: '2',
		sm: '2',
		md: '2.25',
		lg: '2.5',
	};
</script>

<span
	role="status"
	aria-live="polite"
	class={cn('inline-flex shrink-0 items-center justify-center', SIZE[size], className)}
>
	<svg
		viewBox="0 0 24 24"
		class="size-full animate-spin"
		fill="none"
		stroke="currentColor"
		stroke-width={STROKE[size]}
		stroke-linecap="round"
		aria-hidden="true"
	>
		<circle cx="12" cy="12" r="9" class="opacity-20" />
		<path d="M21 12a9 9 0 0 1-9 9" class="opacity-90" />
	</svg>
	<span class="sr-only">{label}</span>
</span>
