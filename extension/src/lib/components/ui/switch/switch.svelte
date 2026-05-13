<script lang="ts">
	import { cn } from "$lib/utils.js";
	import type { HTMLButtonAttributes } from "svelte/elements";

	type Props = Omit<HTMLButtonAttributes, 'onchange'> & {
		checked?: boolean;
		onCheckedChange?: (next: boolean) => void;
	};

	let {
		checked = $bindable(false),
		onCheckedChange,
		class: className,
		disabled,
		...restProps
	}: Props = $props();

	function toggle() {
		const next = !checked;
		checked = next;
		onCheckedChange?.(next);
	}
</script>

<button
	type="button"
	role="switch"
	aria-checked={checked}
	data-state={checked ? 'checked' : 'unchecked'}
	data-slot="switch"
	{disabled}
	onclick={toggle}
	class={cn(
		"peer inline-flex h-[1.15rem] w-8 shrink-0 cursor-pointer items-center rounded-full border border-transparent shadow-xs transition-all outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50",
		checked ? 'bg-primary' : 'bg-input dark:bg-input/80',
		className
	)}
	{...restProps}
>
	<span
		data-slot="switch-thumb"
		data-state={checked ? 'checked' : 'unchecked'}
		class={cn(
			"pointer-events-none block size-4 rounded-full ring-0 transition-transform",
			checked
				? 'translate-x-[calc(100%-2px)] bg-background dark:bg-primary-foreground'
				: 'translate-x-0 bg-background dark:bg-foreground'
		)}
	></span>
</button>
