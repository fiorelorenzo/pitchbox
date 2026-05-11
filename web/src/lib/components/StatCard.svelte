<script lang="ts">
	import type { ComponentType } from 'svelte';
	import type { Icon as LucideIcon } from 'lucide-svelte';

	let {
		label,
		value,
		hint,
		icon,
		href,
	}: {
		label: string;
		value: number | string;
		hint?: string;
		icon?: ComponentType<LucideIcon>;
		href?: string;
	} = $props();
</script>

{#snippet content()}
	<div
		class="flex flex-col gap-1 p-4 h-full border border-border rounded-lg bg-card hover:bg-accent/20 transition-colors"
	>
		<div class="flex items-center gap-2 text-xs text-muted-foreground">
			{#if icon}
				{@const Icon = icon}
				<Icon class="size-3.5 text-muted-foreground" />
			{/if}
			<span>{label}</span>
		</div>
		<div class="text-2xl font-semibold tabular-nums text-foreground">{value}</div>
		{#if hint}
			<div class="text-[11px] text-muted-foreground/80 mt-auto">{hint}</div>
		{/if}
	</div>
{/snippet}

{#if href}
	<a {href} class="block">{@render content()}</a>
{:else}
	{@render content()}
{/if}
