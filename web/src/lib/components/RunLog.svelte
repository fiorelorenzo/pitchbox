<script lang="ts">
	import { onMount, onDestroy, tick } from 'svelte';
	import { Loader, ChevronsDown, AlertTriangle } from '@lucide/svelte';
	import { toast } from 'svelte-sonner';
	import { getSseManager, type SseStatus } from '$lib/realtime/sse';
	import {
		resolveBadge,
		resolveTone,
		PULSE_DOT_CLASS,
		TONE_BANNER_CLASS,
	} from '$lib/config/status-badges';

	import { relativeTimeFine } from '$lib/utils/time';
	import { resetParser, dbEventToTimeline, pairToolEvents } from './runlog/parse';
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

	// Maps tool-call id → index in `events` for live SSE pairing.
	const liveToolCallMap = new Map<string, number>();

	// Scroll / pin
	let pinned = $state(true);
	let scrollEl: HTMLElement | null = null;
	let hasResultEvent = false;
	let lastEventTs = $state<number | null>(null);

	// SSE: subscribe through the shared manager (web/src/lib/realtime/sse.ts)
	// instead of opening a private EventSource, so every mounted RunLog reuses
	// one connection and can read its real status instead of just going quiet.
	const sseManager = getSseManager();
	let sseStatus = $state<SseStatus>('connecting');
	let justReconnected = $state(false);
	let reconnectedTimer: ReturnType<typeof setTimeout> | null = null;
	const unsubs: Array<() => void> = [];

	type RunStatus = 'Idle' | 'Running' | 'Finished' | 'Failed' | 'Cancelled';
	let status = $state<RunStatus>('Idle');
	let loadError = $state<string | null>(null);

	let statusDotClass = $derived(
		PULSE_DOT_CLASS[resolveTone('run-live-status', status)] +
			(resolveBadge('run-live-status', status).pulse ? ' animate-pulse' : ''),
	);

	// Mirrors SseIndicator's connection-status mapping so the run log dot uses
	// the same four-state palette as the sidebar indicator.
	const connectionKey = $derived(
		sseStatus === 'live'
			? 'live'
			: sseStatus === 'reconnecting'
				? 'warn'
				: sseStatus === 'closed'
					? 'down'
					: 'idle',
	);

	// A dropped stream only matters to the user while a run is actually in
	// flight - an idle log with no active run has nothing to stream, so it
	// must not be flagged as broken.
	const showStreamBanner = $derived(
		status === 'Running' && (connectionKey === 'warn' || connectionKey === 'down'),
	);
	const streamBannerText = $derived(
		connectionKey === 'down'
			? 'Live updates disconnected. Refresh the page to resume.'
			: 'Live updates interrupted, reconnecting… new events may be delayed.',
	);
	const streamBannerClass = $derived(TONE_BANNER_CLASS[resolveTone('connection-status', connectionKey)]);
	const streamDotClass = $derived.by(() => {
		const dot = PULSE_DOT_CLASS[resolveTone('connection-status', connectionKey)];
		return resolveBadge('connection-status', connectionKey).pulse ? `${dot} animate-pulse` : dot;
	});

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
		loadError = null;
		try {
			const res = await fetch(`/api/runs/${rid}/events`);
			if (!res.ok) {
				const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
				const message =
					res.status >= 500
						? 'Could not load the run log. Please try again.'
						: (body.error ?? body.message ?? 'Could not load the run log.');
				if (res.status >= 500) console.error('failed to load run events', rid, res.status, body);
				loadError = message;
				toast.error(message);
				return;
			}
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
			const hydrated = pairToolEvents(body.events.map((e) => dbEventToTimeline(e)));
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
			const message = 'Could not load the run log, check your connection.';
			loadError = message;
			toast.error(message);
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
		unsubs.push(
			sseManager.on('run:started', (e: MessageEvent) => {
				const { runId: rid } = JSON.parse(e.data);
				if (runId === null || rid === runId) {
					events = [];
					start = null;
					maxSeen = -1;
					hasResultEvent = false;
					status = 'Running';
					resetParser();
					liveToolCallMap.clear();
				}
			}),
		);

		unsubs.push(
			sseManager.on('run:log', async (e: MessageEvent) => {
				const data = JSON.parse(e.data) as {
					runId: number;
					event?: { id: number; seq: number; kind: string; payload: unknown; ts: string; raw: string } | null;
					line?: string;
				};
				const { runId: rid, event } = data;
				if (runId !== null && rid !== runId) return;

				if (!event) {
					// Null event (blank/comment line) - nothing to display.
					return;
				}

				// Dedup: skip if we already have this event from history load.
				if (event.id <= maxSeen) return;
				maxSeen = event.id;

				const te = dbEventToTimeline({ id: event.id, kind: event.kind, payload: event.payload, ts: event.ts });
				if (te.kind === 'result') hasResultEvent = true;

				// Live pairing: tool-call → register; tool-result → merge or append standalone
				if (te.kind === 'tool-call' && te.toolCall?.id) {
					// Will be appended at index = current events.length
					liveToolCallMap.set(te.toolCall.id, events.length);
					await appendEvents([te]);
				} else if (te.kind === 'tool-result' && te.toolResult) {
					const uid = te.toolResult.toolUseId;
					if (uid && liveToolCallMap.has(uid)) {
						// Merge into the existing tool-call event
						const idx = liveToolCallMap.get(uid)!;
						const { extractExitCode } = await import('./runlog/parse');
						const tr = te.toolResult;
						const exitCode = extractExitCode(tr.text);
						const isError =
							tr.isError ||
							(exitCode !== undefined && exitCode !== 0) ||
							(tr.parsedEnvelope != null && !tr.parsedEnvelope.ok);
						events = events.map((e, i) => {
							if (i !== idx || !e.toolCall) return e;
							return {
								...e,
								toolCall: {
									...e.toolCall,
									pairedResult: {
										isError,
										text: tr.text,
										raw: tr.raw,
										parsedEnvelope: tr.parsedEnvelope ?? null,
										exitCode,
									},
								},
							};
						});
					} else {
						// Orphan tool-result
						await appendEvents([te]);
					}
				} else {
					await appendEvents([te]);
				}
			}),
		);

		unsubs.push(
			sseManager.on('run:finished', async (e: MessageEvent) => {
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
			}),
		);

		unsubs.push(
			sseManager.subscribeStatus((s) => {
				const prev = sseStatus;
				sseStatus = s;
				// The SSE transport does not replay missed events, so a real
				// reconnect (not the initial boot) means the log may be behind.
				// Refetch the run's history from the DB rather than leaving it
				// silently stale, and tell the user we did.
				if (s === 'live' && (prev === 'reconnecting' || prev === 'closed') && runId != null) {
					loadHistory(runId);
					justReconnected = true;
					if (reconnectedTimer) clearTimeout(reconnectedTimer);
					reconnectedTimer = setTimeout(() => (justReconnected = false), 5000);
				}
			}),
		);
	});

	onDestroy(() => {
		unsubs.forEach((unsub) => unsub());
		if (reconnectedTimer) clearTimeout(reconnectedTimer);
	});
</script>

<div class="flex flex-col gap-2 min-w-0 overflow-hidden">
	<!-- Status bar -->
	<div class="flex items-center gap-2 text-xs text-muted-foreground px-1">
		<span class="inline-block size-2 rounded-full shrink-0 {statusDotClass}"></span>
		<span class="font-medium text-foreground">{status}</span>
		{#if runId != null}
			<span class="bg-muted rounded px-1.5 py-0.5 font-mono">#{runId}</span>
		{:else}
			<span class="italic">Listening for runs…</span>
		{/if}
		<span class="ml-auto shrink-0">{events.length} events</span>
	</div>

	{#if showStreamBanner}
		<div class="flex items-center gap-2 rounded-md border px-2 py-1.5 text-xs {streamBannerClass}">
			<span class="inline-block size-1.5 rounded-full shrink-0 {streamDotClass}"></span>
			<span>{streamBannerText}</span>
		</div>
	{:else if justReconnected}
		<div class="px-1 text-xs text-muted-foreground">
			Reconnected. Log refreshed in case any events were missed.
		</div>
	{/if}

	<!-- Events -->
	<div class="relative min-w-0">
		<div
			bind:this={scrollEl}
			onscroll={onScroll}
			class="max-h-[440px] overflow-y-auto overflow-x-hidden pr-1"
		>
			{#if events.length === 0}
				{#if loadError}
					<div
						role="alert"
						class="mx-1 my-2 flex items-start gap-2 rounded-lg border px-3 py-2 text-xs {TONE_BANNER_CLASS.rose}"
					>
						<AlertTriangle class="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
						<div class="flex-1">
							<p>{loadError}</p>
							<button
								type="button"
								onclick={() => runId != null && loadHistory(runId)}
								class="mt-1 underline underline-offset-2 hover:no-underline"
							>
								Retry
							</button>
						</div>
					</div>
				{:else if status === 'Running'}
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
						Idle - start a run to see events here.
					</p>
				{/if}
			{:else}
				<div class="relative min-w-0">
					{#each events as ev, i (ev.id)}
						{@const isFirst = i === 0}
						{@const isLast = i === events.length - 1}
						{@const offset = relativeTimeFine(new Date(ev.ts))}
						{@const isError = ev.result ? !ev.result.success : (ev.toolResult?.isError ?? false)}

						<EventRow kind={ev.kind} {isFirst} {isLast} {offset} {isError}>
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
