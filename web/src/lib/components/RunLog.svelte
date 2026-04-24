<script lang="ts">
	import { onMount, onDestroy, tick } from 'svelte';
	import { Loader, ChevronsDown } from 'lucide-svelte';

	import { formatOffset } from '$lib/utils/time';
	import { parse, resetParser, dbEventToTimeline } from './runlog/parse';
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

	// Tracks the highest DB-persisted event id we've seen, to dedup SSE arrivals.
	let maxSeen = $state(-1);

	// Scroll / pin
	let pinned = $state(true);
	let scrollEl: HTMLElement | null = null;
	let hasResultEvent = false;
	let lastEventTs = $state<number | null>(null);

	// SSE
	let es: EventSource | null = null;

	type RunStatus = 'Idle' | 'Running' | 'Finished' | 'Failed' | 'Cancelled';
	let status = $state<RunStatus>('Idle');

	const STATUS_DOT: Record<RunStatus, string> = {
		Idle: 'bg-slate-400',
		Running: 'bg-green-400 animate-pulse',
		Finished: 'bg-emerald-500',
		Failed: 'bg-destructive',
		Cancelled: 'bg-amber-400',
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

	/** Load historical events from the DB endpoint. */
	async function loadHistory(rid: number) {
		try {
			const res = await fetch(`/api/runs/${rid}/events`);
			if (!res.ok) return;
			const body = (await res.json()) as {
				runId: number;
				run: { status: string } | null;
				events: Array<{ id: number; seq: number; kind: string; payload: unknown; ts: string }>;
			};

			// Set status from run metadata first (handles finished runs with no result event).
			if (body.run) {
				const s = body.run.status;
				if (s === 'running') status = 'Running';
				else if (s === 'success') status = 'Finished';
				else if (s === 'failed' || s === 'error') status = 'Failed';
				else if (s === 'cancelled') status = 'Cancelled';
				// 'queued' and anything else stays 'Idle'
			}

			if (!body.events.length) return;

			resetParser();
			const hydrated = body.events.map((e) => dbEventToTimeline(e));
			hasResultEvent = hydrated.some((e) => e.kind === 'result');
			maxSeen = Math.max(...body.events.map((e) => e.id));
			start = hydrated[0].ts;
			lastEventTs = hydrated[hydrated.length - 1].ts;
			events = hydrated;
			// Refine status from result event if present (overrides run metadata for accuracy).
			if (hydrated.some((e) => e.kind === 'result')) {
				const resultEv = hydrated.findLast((e) => e.kind === 'result');
				status = resultEv?.result?.success ? 'Finished' : 'Failed';
			}
			await tick();
			if (scrollEl) scrollEl.scrollTop = scrollEl.scrollHeight;
		} catch {
			// silently ignore
		}
	}

	/** Reset and re-hydrate when runId prop changes. */
	$effect(() => {
		const rid = runId;
		events = [];
		start = null;
		maxSeen = -1;
		hasResultEvent = false;
		status = 'Idle';
		resetParser();
		if (rid != null) {
			loadHistory(rid);
		}
	});

	onMount(() => {
		es = new EventSource('/api/stream');

		es.addEventListener('run:started', (e: MessageEvent) => {
			const { runId: rid } = JSON.parse(e.data);
			if (runId === null || rid === runId) {
				events = [];
				start = null;
				maxSeen = -1;
				hasResultEvent = false;
				status = 'Running';
				resetParser();
			}
		});

		es.addEventListener('run:log', async (e: MessageEvent) => {
			const data = JSON.parse(e.data) as {
				runId: number;
				event?: { id: number; seq: number; kind: string; payload: unknown; ts: string; raw: string } | null;
				line?: string;
			};
			const { runId: rid, event } = data;
			if (runId !== null && rid !== runId) return;

			if (!event) {
				// Null event (blank/comment line) — nothing to display.
				return;
			}

			// Dedup: skip if we already have this event from history load.
			if (event.id <= maxSeen) return;
			maxSeen = event.id;

			const te = dbEventToTimeline({ id: event.id, kind: event.kind, payload: event.payload, ts: event.ts });
			if (te.kind === 'result') hasResultEvent = true;
			await appendEvents([te]);
		});

		es.addEventListener('run:finished', async (e: MessageEvent) => {
			const { runId: rid, exitCode, error } = JSON.parse(e.data);
			if (runId === null || rid === runId) {
				if (exitCode === 0) {
					status = 'Finished';
				} else if (error === 'cancelled by user') {
					status = 'Cancelled';
				} else {
					status = 'Failed';
				}
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

<div class="flex flex-col gap-2 min-w-0 overflow-hidden">
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
					<div
						class="flex flex-col items-center justify-center gap-2 py-10 text-muted-foreground/50"
					>
						<Loader class="size-4 animate-spin" />
						<span class="text-xs">Waiting for the first event…</span>
					</div>
				{:else if runId != null}
					<div class="flex flex-col items-center justify-center gap-1 py-10 text-center">
						<p class="text-xs text-muted-foreground/60">No events recorded for run #{runId}.</p>
						<p class="text-[10px] text-muted-foreground/40 italic">
							This run may pre-date event persistence.
						</p>
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
