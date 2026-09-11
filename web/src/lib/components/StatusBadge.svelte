<script lang="ts">
	import { cn } from '$lib/utils';
	import { page } from '$app/stores';
	import {
		resolveBadge,
		badgeLabel,
		TONE_CLASS,
		PULSE_DOT_CLASS,
		type BadgeDomain,
	} from '$lib/config/status-badges';
	import type { Locale } from '$lib/i18n/index.js';

	type Size = 'xs' | 'sm';

	let {
		domain,
		value,
		size = 'xs',
		class: className,
	}: {
		domain: BadgeDomain;
		value: string;
		size?: Size;
		class?: string;
	} = $props();

	const locale = $derived($page.data.locale as Locale);
	const style = $derived(resolveBadge(domain, value));
	const label = $derived(badgeLabel(locale, domain, value));

	const SIZE_CLS: Record<Size, string> = {
		xs: 'text-[10px] px-1.5 py-[1px] h-[18px] gap-1',
		sm: 'text-xs px-2 py-0.5 h-5 gap-1.5',
	};
</script>

<span
	class={cn(
		'inline-flex items-center rounded-md font-medium ring-1 ring-inset whitespace-nowrap tabular-nums',
		TONE_CLASS[style.tone],
		SIZE_CLS[size],
		className,
	)}
	aria-label={label}
>
	{#if style.pulse}
		<span
			class={cn(
				'size-1.5 rounded-full animate-pulse shrink-0',
				PULSE_DOT_CLASS[style.tone],
			)}
			aria-hidden="true"
		></span>
	{/if}
	<span class="truncate">{label}</span>
</span>
