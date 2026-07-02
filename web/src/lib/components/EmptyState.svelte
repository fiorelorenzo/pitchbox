<script lang="ts">
	import type { Snippet } from 'svelte';
	import { cn } from '$lib/utils';

	// `icon` accepts any Svelte component (typically a lucide icon). Kept weakly
	// typed so call sites are not coupled to a specific icon `Component<...>`
	// signature.
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	type IconComponent = any;

	type Props = {
		icon?: IconComponent;
		title: string;
		description?: string;
		size?: 'sm' | 'md' | 'lg';
		class?: string;
		// Optional inline content rendered below the description (e.g. action buttons).
		children?: Snippet;
	};

	let {
		icon: Icon,
		title,
		description,
		size = 'md',
		class: className,
		children,
	}: Props = $props();

	const PAD: Record<NonNullable<Props['size']>, string> = {
		sm: 'px-4 py-8 gap-3',
		md: 'px-6 py-12 gap-4',
		lg: 'px-6 py-16 gap-4',
	};
	const ICON_BOX: Record<NonNullable<Props['size']>, string> = {
		sm: 'size-10',
		md: 'size-12',
		lg: 'size-14',
	};
	const ICON_SIZE: Record<NonNullable<Props['size']>, string> = {
		sm: 'size-5',
		md: 'size-6',
		lg: 'size-7',
	};
</script>

<div
	class={cn(
		'flex flex-col items-center justify-center text-center',
		PAD[size],
		className,
	)}
>
	{#if Icon}
		<div
			class={cn(
				'flex items-center justify-center rounded-full bg-muted text-muted-foreground',
				ICON_BOX[size],
			)}
		>
			<Icon class={ICON_SIZE[size]} />
		</div>
	{/if}
	<div class="flex flex-col gap-1">
		<p class="text-sm font-medium text-foreground">{title}</p>
		{#if description}
			<p class="max-w-sm text-xs text-muted-foreground">{description}</p>
		{/if}
	</div>
	{#if children}
		<div class="mt-1 flex items-center gap-2">
			{@render children()}
		</div>
	{/if}
</div>
