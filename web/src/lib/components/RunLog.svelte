<script lang="ts">
	import { onMount, onDestroy, tick } from 'svelte';
	import {
		Sparkles,
		Brain,
		Terminal,
		CheckCircle2,
		AlertCircle,
		MessageSquare,
		Gauge,
		Flag,
		HelpCircle,
		ChevronsDown,
	} from 'lucide-svelte';
	import { Badge } from '$lib/components/ui/badge';
	import { formatOffset } from '$lib/utils/time';

	type EventKind =
		| 'session'
		| 'thinking'
		| 'tool-call'
		| 'tool-result'
		| 'assistant'
		| 'rate-limit'
		| 'result'
		| 'unknown';

	interface TimelineEvent {
		id: number;
		kind: EventKind;
		ts: number; // unix ms
		title: string;
		body?: string;
		meta?: Record<string, unknown>;
		isError?: boolean;
		toolName?: string;
		collapsed?: boolean;
	}

	let { runId = null }: { runId?: number | null } = $props();

	let events = $state<TimelineEvent[]>([]);
	let nextId = 0;
	let start = $state<number | null>(null);

	// Scroll / pin state
	let pinned = $state(true);
	let scrollEl: HTMLElement | null = null;
	let hasResultEvent = false;
	let lastEventTs = $state<number | null>(null);

	// SSE
	let es: EventSource | null = null;

	// --- Status derived from events ---
	type RunStatus = 'Idle' | 'Running' | 'Finished' | 'Failed';
	let status = $state<RunStatus>('Idle');

	function defaultCollapsed(kind: EventKind, isError?: boolean): boolean {
		switch (kind) {
			case 'session':
			case 'assistant':
			case 'result':
				return false;
			case 'tool-result':
				// Error results are expanded so the user sees them immediately.
				return !isError;
			case 'thinking':
			case 'tool-call':
			case 'rate-limit':
			case 'unknown':
			default:
				return true;
		}
	}

	function extractToolResultBody(content: unknown): string {
		if (typeof content === 'string') return content;
		if (Array.isArray(content)) {
			const texts = content
				.filter((c): c is { type: string; text: string } => c && c.type === 'text')
				.map((c) => c.text);
			if (texts.length) return texts.join('\n');
		}
		return JSON.stringify(content, null, 2);
	}

	function parse(line: string): TimelineEvent[] {
		if (!line.trim()) return [];
		// skip our own comment banners
		if (line.startsWith('#')) return [];

		let evt: Record<string, unknown>;
		try {
			evt = JSON.parse(line);
		} catch {
			return [];
		}

		const t = evt.type as string | undefined;
		const results: TimelineEvent[] = [];
		const now = Date.now();

		if (t === 'system') {
			const sub = evt.subtype as string | undefined;
			if (sub === 'init') {
				const session = evt as {
					session_id?: string;
					model?: string;
					cwd?: string;
				};
				results.push({
					id: nextId++,
					kind: 'session',
					ts: now,
					title: 'Session started',
					body: session.cwd,
					meta: { sessionId: session.session_id, model: session.model },
					collapsed: false,
				});
			}
			// hook_started / hook_response → skip
			return results;
		}

		if (t === 'assistant') {
			const msg = evt.message as
				| {
						content?: Array<{
							type: string;
							text?: string;
							thinking?: string;
							name?: string;
							id?: string;
							input?: unknown;
						}>;
				  }
				| undefined;
			const content = msg?.content ?? [];
			for (const c of content) {
				if (c.type === 'thinking') {
					const text = c.thinking ?? c.text ?? '';
					if (text) {
						results.push({
							id: nextId++,
							kind: 'thinking',
							ts: now,
							title: 'Thinking…',
							body: text,
							collapsed: true,
						});
					}
				} else if (c.type === 'text') {
					if (c.text) {
						results.push({
							id: nextId++,
							kind: 'assistant',
							ts: now,
							title: 'Assistant',
							body: c.text,
							collapsed: false,
						});
					}
				} else if (c.type === 'tool_use') {
					results.push({
						id: nextId++,
						kind: 'tool-call',
						ts: now,
						title: c.name ?? 'tool',
						toolName: c.name,
						body: JSON.stringify(c.input, null, 2),
						meta: { id: c.id },
						collapsed: true,
					});
				}
			}
			return results;
		}

		if (t === 'user') {
			const msg = evt.message as
				| {
						content?: Array<{
							type: string;
							content?: unknown;
							is_error?: boolean;
							tool_use_id?: string;
						}>;
				  }
				| undefined;
			const content = msg?.content ?? [];
			for (const c of content) {
				if (c.type === 'tool_result') {
					const isError = !!c.is_error;
					results.push({
						id: nextId++,
						kind: 'tool-result',
						ts: now,
						title: 'Tool result',
						body: extractToolResultBody(c.content),
						isError,
						meta: { toolUseId: c.tool_use_id },
						collapsed: defaultCollapsed('tool-result', isError),
					});
				}
			}
			return results;
		}

		if (t === 'rate_limit_event') {
			results.push({
				id: nextId++,
				kind: 'rate-limit',
				ts: now,
				title: 'Rate limit',
				body: JSON.stringify(evt.rate_limit_info ?? evt, null, 2),
				collapsed: true,
			});
			return results;
		}

		if (t === 'result') {
			const r = evt as {
				subtype?: string;
				result?: unknown;
				total_cost_usd?: number;
				duration_ms?: number;
				usage?: { input_tokens?: number; output_tokens?: number };
				is_error?: boolean;
			};
			results.push({
				id: nextId++,
				kind: 'result',
				ts: now,
				title: r.subtype === 'success' ? 'Run succeeded' : 'Run failed',
				body: r.result != null ? String(r.result) : undefined,
				meta: {
					total_cost_usd: r.total_cost_usd,
					duration_ms: r.duration_ms,
					input_tokens: r.usage?.input_tokens,
					output_tokens: r.usage?.output_tokens,
					is_error: r.is_error,
				},
				isError: r.subtype !== 'success',
				collapsed: false,
			});
			return results;
		}

		// Unknown
		results.push({
			id: nextId++,
			kind: 'unknown',
			ts: now,
			title: t ?? 'event',
			body: line,
			collapsed: true,
		});
		return results;
	}

	async function appendEvents(newEvents: TimelineEvent[]) {
		if (!newEvents.length) return;
		if (start === null) start = newEvents[0].ts;
		lastEventTs = newEvents[newEvents.length - 1].ts;
		events = [...events, ...newEvents];
		if (pinned) {
			await tick();
			if (scrollEl) {
				scrollEl.scrollTop = scrollEl.scrollHeight;
			}
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
		if (scrollEl) {
			scrollEl.scrollTop = scrollEl.scrollHeight;
		}
	}

	function toggleCollapsed(ev: TimelineEvent) {
		ev.collapsed = !ev.collapsed;
		// Trigger reactivity — mutating a nested object property requires reassignment.
		events = events.map((e) => (e.id === ev.id ? { ...e, collapsed: ev.collapsed } : e));
	}

	/** First ~60 chars of body for the collapsed preview, if available. */
	function preview(body: string | undefined): string {
		if (!body) return '';
		const first = body.replace(/\s+/g, ' ').trim().slice(0, 60);
		return first.length < (body.replace(/\s+/g, ' ').trim().length) ? first + '…' : first;
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
				nextId = 0;
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
			const { runId: rid, exitCode } = JSON.parse(e.data);
			if (runId === null || rid === runId) {
				status = exitCode === 0 ? 'Finished' : 'Failed';
				if (!hasResultEvent) {
					await appendEvents([
						{
							id: nextId++,
							kind: 'result',
							ts: Date.now(),
							title: exitCode === 0 ? 'Run succeeded' : 'Run failed',
							meta: { exitCode },
							isError: exitCode !== 0,
							collapsed: false,
						},
					]);
				}
			}
		});
	});

	onDestroy(() => es?.close());

	// --- Icon mapping ---
	const KIND_ICON: Record<EventKind, typeof Brain> = {
		session: Sparkles,
		thinking: Brain,
		'tool-call': Terminal,
		'tool-result': CheckCircle2,
		assistant: MessageSquare,
		'rate-limit': Gauge,
		result: Flag,
		unknown: HelpCircle,
	};

	const KIND_LABEL: Record<EventKind, string> = {
		session: 'session',
		thinking: 'thinking',
		'tool-call': 'tool',
		'tool-result': 'result',
		assistant: 'assistant',
		'rate-limit': 'rate limit',
		result: 'result',
		unknown: 'unknown',
	};

	const KIND_DOT_COLOR: Record<EventKind, string> = {
		session: 'bg-violet-400',
		thinking: 'bg-slate-400',
		'tool-call': 'bg-blue-400',
		'tool-result': 'bg-green-400',
		assistant: 'bg-sky-400',
		'rate-limit': 'bg-yellow-400',
		result: 'bg-primary',
		unknown: 'bg-slate-300',
	};

	const KIND_BADGE_VARIANT: Record<
		EventKind,
		'default' | 'secondary' | 'destructive' | 'outline'
	> = {
		session: 'outline',
		thinking: 'secondary',
		'tool-call': 'outline',
		'tool-result': 'outline',
		assistant: 'secondary',
		'rate-limit': 'outline',
		result: 'default',
		unknown: 'outline',
	};

	const STATUS_DOT: Record<RunStatus, string> = {
		Idle: 'bg-slate-400',
		Running: 'bg-green-400 animate-pulse',
		Finished: 'bg-emerald-500',
		Failed: 'bg-destructive',
	};

	function formatCost(usd: unknown): string {
		if (usd == null) return '';
		return `$${Number(usd).toFixed(4)}`;
	}

	function formatTokens(n: unknown): string {
		if (n == null) return '—';
		return Number(n).toLocaleString();
	}

	/** Whether this event type can be collapsed/expanded by user. */
	function isCollapsible(kind: EventKind): boolean {
		return kind === 'thinking' || kind === 'tool-call' || kind === 'tool-result' || kind === 'rate-limit' || kind === 'unknown';
	}

	/** Whether to use monospace / JSON styling for the body. */
	function isMonoBody(kind: EventKind): boolean {
		return kind === 'tool-call' || kind === 'tool-result' || kind === 'rate-limit' || kind === 'unknown';
	}
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
		{#if lastEventTs}
			<span class="shrink-0">{formatOffset(Date.now() - lastEventTs)} ago</span>
		{/if}
	</div>

	<!-- Events list -->
	<div class="relative min-w-0">
		<div
			bind:this={scrollEl}
			onscroll={onScroll}
			class="max-h-[360px] overflow-y-auto overflow-x-hidden pr-1"
		>
			{#if events.length === 0}
				<p class="text-xs text-muted-foreground text-center py-8">
					{runId == null ? 'Waiting for a run to start…' : 'No events yet.'}
				</p>
			{:else}
				<div class="relative min-w-0">
					{#each events as ev, i (ev.id)}
						{@const isLast = i === events.length - 1}
						{@const offset = start != null ? formatOffset(ev.ts - start) : ''}
						{@const Icon = ev.kind === 'tool-result' && ev.isError ? AlertCircle : KIND_ICON[ev.kind]}
						{@const badgeVariant =
							ev.kind === 'result' && ev.isError
								? 'destructive'
								: ev.kind === 'tool-result' && ev.isError
									? 'destructive'
									: KIND_BADGE_VARIANT[ev.kind]}
						{@const dotColor =
							ev.kind === 'tool-result' && ev.isError
								? 'bg-destructive'
								: ev.kind === 'result' && ev.isError
									? 'bg-destructive'
									: KIND_DOT_COLOR[ev.kind]}
						{@const collapsible = isCollapsible(ev.kind)}
						{@const monoBody = isMonoBody(ev.kind)}
						{@const isResultKind = ev.kind === 'result'}
						{@const hasBody = !!ev.body}
						{@const bodyPreview = ev.collapsed && hasBody && !isResultKind && ev.kind !== 'thinking'
							? preview(ev.body)
							: ''}

						<div
							class="flex gap-3 min-w-0 {isResultKind ? 'border-l-2 border-primary pl-2' : 'pl-0'} {isResultKind && ev.isError ? 'border-destructive' : ''} border-b border-border/40 last:border-b-0"
						>
							<!-- Gutter: fixed-width, flex-none so it never overlaps text -->
							<div class="flex flex-col items-center w-5 flex-none">
								<span class="mt-1.5 size-2.5 rounded-full flex-none {dotColor}">
									<Icon class="size-2.5 opacity-0 absolute" />
								</span>
								{#if !isLast}
									<span class="w-px flex-1 bg-border/60 mt-0.5 min-h-[8px]"></span>
								{/if}
							</div>

							<!-- Content -->
							<div class="flex-1 min-w-0 pb-3">
								<!-- Header row -->
								<div class="flex items-center gap-2 mb-1 flex-wrap min-w-0">
									<Badge variant={badgeVariant} class="text-xs gap-1 py-0 px-1.5 h-5 shrink-0 flex items-center">
										<Icon class="size-3 flex-none" />
										<span>{ev.kind === 'tool-call' && ev.toolName ? ev.toolName : KIND_LABEL[ev.kind]}</span>
									</Badge>
									<span class="font-medium text-xs truncate min-w-0 flex-1">{ev.title}</span>
									{#if bodyPreview}
										<span class="text-xs text-muted-foreground italic truncate min-w-0 max-w-[160px]">{bodyPreview}</span>
									{/if}
									<span class="ml-auto text-muted-foreground text-xs font-mono shrink-0">{offset}</span>
									{#if collapsible && hasBody}
										<button
											onclick={() => toggleCollapsed(ev)}
											class="text-xs text-muted-foreground hover:text-foreground shrink-0 underline-offset-2 hover:underline"
										>
											{ev.collapsed ? 'show' : 'hide'}
										</button>
									{/if}
								</div>

								{#if isResultKind && ev.meta}
									<!-- Result meta row -->
									<div class="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground mt-1 mb-2">
										{#if ev.meta.input_tokens != null}
											<span>in: {formatTokens(ev.meta.input_tokens)}</span>
										{/if}
										{#if ev.meta.output_tokens != null}
											<span>out: {formatTokens(ev.meta.output_tokens)}</span>
										{/if}
										{#if ev.meta.duration_ms != null}
											<span>{Math.round(Number(ev.meta.duration_ms) / 1000)}s</span>
										{/if}
										{#if ev.meta.total_cost_usd != null}
											<span>{formatCost(ev.meta.total_cost_usd)}</span>
										{/if}
									</div>
								{/if}

								{#if hasBody && !ev.collapsed}
									{#if monoBody}
										<div class="mt-1 overflow-x-auto max-h-64 rounded bg-muted/50">
											<pre class="font-mono text-xs whitespace-pre break-all p-2">{ev.body}</pre>
										</div>
									{:else}
										<!-- prose text for assistant / session / result -->
										<p class="text-sm whitespace-pre-wrap break-words min-w-0">{ev.body}</p>
									{/if}
								{/if}
							</div>
						</div>
					{/each}
				</div>
			{/if}
		</div>

		<!-- Jump to latest button -->
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
