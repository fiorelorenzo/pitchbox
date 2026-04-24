<script lang="ts">
	import { Checkbox as CheckboxPrimitive } from 'bits-ui';
	import { Check, Minus } from 'lucide-svelte';
	import { cn, type WithoutChildrenOrChild } from '$lib/utils.js';

	let {
		ref = $bindable(null),
		class: className,
		checked = $bindable(false),
		indeterminate = $bindable(false),
		...restProps
	}: WithoutChildrenOrChild<CheckboxPrimitive.RootProps> = $props();
</script>

<CheckboxPrimitive.Root
	bind:ref
	bind:checked
	bind:indeterminate
	data-slot="checkbox"
	class={cn(
		'peer size-4 shrink-0 rounded-[4px] border border-input bg-background shadow-xs transition-colors outline-none',
		'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-0',
		'data-[state=checked]:bg-primary data-[state=checked]:border-primary data-[state=checked]:text-primary-foreground',
		'data-[state=indeterminate]:bg-primary data-[state=indeterminate]:border-primary data-[state=indeterminate]:text-primary-foreground',
		'hover:border-primary/60 disabled:cursor-not-allowed disabled:opacity-50',
		className,
	)}
	{...restProps}
>
	{#snippet children({ checked, indeterminate })}
		<div class="flex items-center justify-center text-current pointer-events-none">
			{#if indeterminate}
				<Minus class="size-3" strokeWidth={3} />
			{:else if checked}
				<Check class="size-3" strokeWidth={3} />
			{/if}
		</div>
	{/snippet}
</CheckboxPrimitive.Root>
