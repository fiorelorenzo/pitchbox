<script lang="ts">
	import { fly } from 'svelte/transition';
	import type { EventKind } from './types';
	import type { Snippet } from 'svelte';

	let {
		kind,
		isLast,
		offset,
		isError = false,
		children,
	}: {
		kind: EventKind;
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
	<!-- Gutter -->
	<div class="flex flex-col items-center w-5 flex-none">
		<span class="mt-[18px] size-2 rounded-full flex-none {dotColor}"></span>
		{#if !isLast}
			<span class="w-px flex-1 bg-border/40 mt-1 min-h-[8px]"></span>
		{/if}
	</div>

	<!-- Content + timestamp -->
	<div class="flex-1 min-w-0 pb-2.5 pt-[14px]">
		<div class="flex items-start gap-2 min-w-0">
			<div class="flex-1 min-w-0">
				{@render children()}
			</div>
			{#if offset}
				<span class="text-[10px] text-muted-foreground/40 font-mono shrink-0 mt-0.5 tabular-nums">
					{offset}
				</span>
			{/if}
		</div>
	</div>
</div>
