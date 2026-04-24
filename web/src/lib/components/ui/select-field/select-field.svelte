<script lang="ts" generics="T extends string | number">
	import * as Select from '$lib/components/ui/select';
	import { ChevronDown } from 'lucide-svelte';
	import { cn } from '$lib/utils';

	type Option = { value: T; label: string; disabled?: boolean };

	type Props = {
		value?: T;
		options: Option[];
		placeholder?: string;
		size?: 'sm' | 'default';
		fullWidth?: boolean;
		disabled?: boolean;
		class?: string;
		id?: string;
		name?: string;
		onValueChange?: (v: T) => void;
	};

	let {
		value = $bindable(),
		options,
		placeholder = 'Select…',
		size = 'default',
		fullWidth = false,
		disabled = false,
		class: className,
		id,
		name,
		onValueChange,
	}: Props = $props();

	// bits-ui Select only accepts string values at the primitive level. Cast at the boundary.
	const stringValue = $derived(value === undefined || value === null ? '' : String(value));

	function handleChange(next: string) {
		if (next === '') {
			value = undefined as unknown as T;
		} else if (typeof options[0]?.value === 'number') {
			value = Number(next) as T;
		} else {
			value = next as T;
		}
		if (onValueChange && value !== undefined) onValueChange(value);
	}

	const selected = $derived(options.find((o) => String(o.value) === stringValue));
	const label = $derived(selected?.label ?? '');

	const HEIGHT: Record<'sm' | 'default', string> = {
		sm: 'h-8 text-xs px-2.5',
		default: 'h-9 text-sm px-3',
	};
</script>

<Select.Root
	type="single"
	value={stringValue}
	onValueChange={handleChange}
	{disabled}
	{name}
	items={options.map((o) => ({ value: String(o.value), label: o.label, disabled: o.disabled }))}
>
	<Select.Trigger
		{id}
		class={cn(
			'inline-flex items-center justify-between gap-2',
			'rounded-md border border-input bg-background font-medium text-foreground',
			'hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:border-input',
			'disabled:cursor-not-allowed disabled:opacity-50 transition-colors outline-none',
			fullWidth ? 'w-full' : 'w-fit min-w-[8rem]',
			HEIGHT[size],
			className,
		)}
	>
		<span class={cn('truncate', !label && 'text-muted-foreground')}>
			{label || placeholder}
		</span>
		<ChevronDown class="size-3.5 text-muted-foreground shrink-0" />
	</Select.Trigger>
	<Select.Content class="max-h-60">
		{#each options as opt (opt.value)}
			<Select.Item value={String(opt.value)} label={opt.label} disabled={opt.disabled}>
				{opt.label}
			</Select.Item>
		{/each}
	</Select.Content>
</Select.Root>
