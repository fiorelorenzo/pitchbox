<script lang="ts">
	import type { ComponentType } from 'svelte';
	import type { Icon as LucideIcon } from 'lucide-svelte';

	let {
		label,
		value,
		hint,
		icon,
		href,
		accent = 'default',
	}: {
		label: string;
		value: number | string;
		hint?: string;
		icon?: ComponentType<LucideIcon>;
		href?: string;
		accent?: 'default' | 'primary' | 'success' | 'warning' | 'destructive';
	} = $props();

	const ACCENT_CLS: Record<NonNullable<typeof accent>, string> = {
		default: 'text-foreground',
		primary: 'text-primary',
		success: 'text-emerald-400',
		warning: 'text-amber-400',
		destructive: 'text-destructive',
	};

	const iconCls = $derived(ACCENT_CLS[accent]);
</script>

{#snippet content()}
	<div class="flex flex-col gap-1 p-4 h-full border border-border rounded-lg bg-card hover:bg-accent/20 transition-colors">
		<div class="flex items-center gap-2 text-xs text-muted-foreground">
			{#if icon}
				{@const Icon = icon}
				<Icon class="size-3.5 {iconCls}" />
			{/if}
			<span>{label}</span>
		</div>
		<div class="text-2xl font-semibold tabular-nums {iconCls}">{value}</div>
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
