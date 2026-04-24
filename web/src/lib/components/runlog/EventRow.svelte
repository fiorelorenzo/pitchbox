<script lang="ts">
	import { fly } from 'svelte/transition';
	import type { EventKind } from './types';
	import type { Snippet } from 'svelte';

	let {
		kind,
		isFirst = false,
		isLast,
		offset,
		isError = false,
		children,
	}: {
		kind: EventKind;
		isFirst?: boolean;
		isLast: boolean;
		offset: string;
		isError?: boolean;
		children: Snippet;
	} = $props();

	const DOT_COLOR: Record<EventKind, string> = {
		session: 'bg-violet-400',
		thinking: 'bg-slate-400',
		'tool-call': 'bg-blue-400',
		'tool-result': 'bg-green-400',
		assistant: 'bg-sky-400',
		'rate-limit': 'bg-yellow-400/30',
		result: 'bg-primary',
		unknown: 'bg-slate-300/30',
	};

	let dotColor = $derived(
		isError && (kind === 'tool-result' || kind === 'result') ? 'bg-destructive' : DOT_COLOR[kind],
	);

	let isResultKind = $derived(kind === 'result');
</script>

<div
	in:fly={{ y: 6, duration: 180 }}
	class="flex gap-3 min-w-0 hover:bg-muted/20 rounded transition-colors py-0.5
	{isResultKind
		? 'border-l-2 pl-2 ' + (isError ? 'border-destructive' : 'border-primary')
		: 'pl-0'}
	border-b border-border/30 last:border-b-0"
>
	<!-- Gutter: dot at y=18px, continuous connector line above (except first) and below (except last) -->
	<div class="flex flex-col items-center w-5 flex-none">
		<span class="w-px h-[18px] {isFirst ? '' : 'bg-border/40'}"></span>
		<span class="size-2 rounded-full flex-none {dotColor}"></span>
		<span class="w-px flex-1 min-h-[4px] {isLast ? '' : 'bg-border/40'}"></span>
	</div>

	<!-- Content + timestamp. pt-[14px] aligns the first line of text with the 18px-offset dot. -->
	<div class="flex-1 min-w-0 pb-2.5 pt-[14px]">
		<div class="flex items-start gap-2 min-w-0">
			<div class="flex-1 min-w-0">
				{@render children()}
			</div>
			{#if offset}
				<span class="text-[10px] text-muted-foreground/40 font-mono shrink-0 mt-[2px] tabular-nums">
					{offset}
				</span>
			{/if}
		</div>
	</div>
</div>
