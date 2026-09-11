<script lang="ts">
	import { Monitor, Sun, Moon } from '@lucide/svelte';
	import { setMode, userPrefersMode } from 'mode-watcher';
	import { page } from '$app/stores';
	import { cn } from '$lib/utils';
	import { t, type Locale } from '$lib/i18n/index.js';

	type Choice = 'system' | 'light' | 'dark';

	const locale = $derived($page.data.locale as Locale);

	const options = $derived<{ value: Choice; label: string; icon: typeof Monitor }[]>([
		{ value: 'system', label: t(locale, 'settings.general.appearance.theme-system'), icon: Monitor },
		{ value: 'light', label: t(locale, 'settings.general.appearance.theme-light'), icon: Sun },
		{ value: 'dark', label: t(locale, 'settings.general.appearance.theme-dark'), icon: Moon },
	]);

	// `userPrefersMode.current` is reactive Svelte 5 $state under the hood.
	const current = $derived<Choice>(userPrefersMode.current as Choice);

	function pick(value: Choice) {
		setMode(value);
	}
</script>

<div
	role="group"
	aria-label={t(locale, 'settings.general.appearance.theme-label')}
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
