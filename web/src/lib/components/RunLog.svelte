<script lang="ts">
	import { onMount, onDestroy, tick } from 'svelte';
	import { Loader, ChevronsDown } from 'lucide-svelte';

	import { formatOffset } from '$lib/utils/time';
	import { parse, resetParser } from './runlog/parse';
	import type { TimelineEvent } from './runlog/types';

	import EventRow from './runlog/EventRow.svelte';
	import SessionEvent from './runlog/SessionEvent.svelte';
	import AssistantEvent from './runlog/AssistantEvent.svelte';
	import ThinkingEvent from './runlog/ThinkingEvent.svelte';
	import ToolCallEvent from './runlog/ToolCallEvent.svelte';
	import ToolResultEvent from './runlog/ToolResultEvent.svelte';
	import RateLimitEvent from './runlog/RateLimitEvent.svelte';
	import ResultEvent from './runlog/ResultEvent.svelte';
	import UnknownEvent from './runlog/UnknownEvent.svelte';

	let { runId = null }: { runId?: number | null } = $props();

	let events = $state<TimelineEvent[]>([]);
	let start = $state<number | null>(null);

	// Scroll / pin
	let pinned = $state(true);
	let scrollEl: HTMLElement | null = null;
	let hasResultEvent = false;
	let lastEventTs = $state<number | null>(null);

	// SSE
	let es: EventSource | null = null;

	type RunStatus = 'Idle' | 'Running' | 'Finished' | 'Failed';
	let status = $state<RunStatus>('Idle');

	const STATUS_DOT: Record<RunStatus, string> = {
		Idle: 'bg-slate-400',
		Running: 'bg-green-400 animate-pulse',
		Finished: 'bg-emerald-500',
		Failed: 'bg-destructive',
	};

	async function appendEvents(newEvents: TimelineEvent[]) {
		if (!newEvents.length) return;
		if (start === null) start = newEvents[0].ts;
		lastEventTs = newEvents[newEvents.length - 1].ts;
		events = [...events, ...newEvents];
		if (pinned) {
			await tick();
			if (scrollEl) scrollEl.scrollTop = scrollEl.scrollHeight;
		}
	}

	function onScroll() {
		if (!scrollEl) return;
		const atBottom = scrollEl.scrollTop + scrollEl.clientHeight >= scrollEl.scrollHeight - 20;
		pinned = atBottom;
	}

	async function jumpToLatest() {
		pinned = true;
		await tick();
		if (scrollEl) scrollEl.scrollTop = scrollEl.scrollHeight;
	}

	function toggleEvent(ev: TimelineEvent) {
		events = events.map((e) => (e.id === ev.id ? { ...e, collapsed: !e.collapsed } : e));
	}

	onMount(() => {
		es = new EventSource('/api/stream');

		es.addEventListener('run:started', (e: MessageEvent) => {
			const { runId: rid } = JSON.parse(e.data);
			if (runId === null || rid === runId) {
				events = [];
				start = null;
				hasResultEvent = false;
				status = 'Running';
				resetParser();
			}
		});

		es.addEventListener('run:log', async (e: MessageEvent) => {
			const { runId: rid, line } = JSON.parse(e.data);
			if (runId === null || rid === runId) {
				const parsed = parse(line);
				if (parsed.some((ev) => ev.kind === 'result')) hasResultEvent = true;
				await appendEvents(parsed);
			}
		});

		es.addEventListener('run:finished', async (e: MessageEvent) => {
			const { runId: rid, exitCode, campaignId: _cid } = JSON.parse(e.data);
			if (runId === null || rid === runId) {
				status = exitCode === 0 ? 'Finished' : 'Failed';
				if (!hasResultEvent) {
					await appendEvents([
						{
							id: -1,
							kind: 'result',
							ts: Date.now(),
							collapsed: false,
							result: {
								success: exitCode === 0,
							},
						},
					]);
				}
			}
		});
	});

	onDestroy(() => es?.close());
</script>

<div class="flex flex-col gap-2 min-w-0">
	<!-- Status bar -->
	<div class="flex items-center gap-2 text-xs text-muted-foreground px-1">
		<span class="inline-block size-2 rounded-full shrink-0 {STATUS_DOT[status]}"></span>
		<span class="font-medium text-foreground">{status}</span>
		{#if runId != null}
			<span class="bg-muted rounded px-1.5 py-0.5 font-mono">#{runId}</span>
		{:else}
			<span class="italic">Listening for runs…</span>
		{/if}
		<span class="ml-auto shrink-0">{events.length} events</span>
	</div>

	<!-- Events -->
	<div class="relative min-w-0">
		<div
			bind:this={scrollEl}
			onscroll={onScroll}
			class="max-h-[440px] overflow-y-auto overflow-x-hidden pr-1"
		>
			{#if events.length === 0}
				{#if status === 'Running'}
					<div class="flex flex-col items-center justify-center gap-2 py-10 text-muted-foreground/50">
						<Loader class="size-4 animate-spin" />
						<span class="text-xs">Waiting for the first event…</span>
					</div>
				{:else}
					<p class="text-xs text-muted-foreground/50 text-center py-10 italic">
						Idle — start a run to see events here.
					</p>
				{/if}
			{:else}
				<div class="relative min-w-0">
					{#each events as ev, i (ev.id)}
						{@const isLast = i === events.length - 1}
						{@const offset = start != null ? formatOffset(ev.ts - start) : ''}
						{@const isError = ev.result ? !ev.result.success : (ev.toolResult?.isError ?? false)}

						<EventRow kind={ev.kind} {isLast} {offset} {isError}>
							{#if ev.kind === 'session' && ev.session}
								<SessionEvent data={ev.session} />
							{:else if ev.kind === 'assistant' && ev.assistant}
								<AssistantEvent data={ev.assistant} />
							{:else if ev.kind === 'thinking' && ev.thinking}
								<ThinkingEvent
									data={ev.thinking}
									collapsed={ev.collapsed}
									ontoggle={() => toggleEvent(ev)}
								/>
							{:else if ev.kind === 'tool-call' && ev.toolCall}
								<ToolCallEvent
									data={ev.toolCall}
									collapsed={ev.collapsed}
									ontoggle={() => toggleEvent(ev)}
								/>
							{:else if ev.kind === 'tool-result' && ev.toolResult}
								<ToolResultEvent
									data={ev.toolResult}
									collapsed={ev.collapsed}
									ontoggle={() => toggleEvent(ev)}
								/>
							{:else if ev.kind === 'rate-limit' && ev.rateLimit}
								<RateLimitEvent data={ev.rateLimit} />
							{:else if ev.kind === 'result' && ev.result}
								<ResultEvent data={ev.result} />
							{:else if ev.kind === 'unknown' && ev.unknown}
								<UnknownEvent data={ev.unknown} />
							{/if}
						</EventRow>
					{/each}
				</div>
			{/if}
		</div>

		<!-- Jump to latest -->
		{#if !pinned && events.length > 0}
			<button
				onclick={jumpToLatest}
				class="absolute bottom-2 right-2 z-10 flex items-center gap-1 text-xs bg-primary text-primary-foreground rounded-full px-3 py-1 shadow-md hover:bg-primary/90 transition-colors"
			>
				<ChevronsDown class="size-3" />
				Jump to latest
			</button>
		{/if}
	</div>
</div>
