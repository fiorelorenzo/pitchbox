<script lang="ts">
	import { Monitor, Sun, Moon } from 'lucide-svelte';
	import { setMode, userPrefersMode } from 'mode-watcher';
	import { cn } from '$lib/utils';

	type Choice = 'system' | 'light' | 'dark';

	const options: { value: Choice; label: string; icon: typeof Monitor }[] = [
		{ value: 'system', label: 'System', icon: Monitor },
		{ value: 'light', label: 'Light', icon: Sun },
		{ value: 'dark', label: 'Dark', icon: Moon },
	];

	// `userPrefersMode.current` is reactive Svelte 5 $state under the hood.
	const current = $derived<Choice>(userPrefersMode.current as Choice);

	function pick(value: Choice) {
		setMode(value);
	}
</script>

<div
	role="group"
	aria-label="Theme"
	class="flex items-center gap-1 rounded-md border border-border bg-background/40 p-0.5"
>
	{#each options as opt (opt.value)}
		{@const Icon = opt.icon}
		{@const active = current === opt.value}
		<button
			type="button"
			aria-label={opt.label}
			aria-pressed={active}
			title={opt.label}
			onclick={() => pick(opt.value)}
			class={cn(
				'flex-1 flex items-center justify-center rounded-sm px-2 py-1.5 text-xs transition-colors',
				active
					? 'bg-accent text-accent-foreground'
					: 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
			)}
		>
			<Icon class="size-3.5" />
		</button>
	{/each}
</div>
