<svelte:options runes={false} />

<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	export let runId: number | null = null;

	let lines: string[] = [];
	let es: EventSource | null = null;

	function pretty(raw: string): string {
		if (!raw.trim()) return '';
		let evt: Record<string, unknown>;
		try {
			evt = JSON.parse(raw);
		} catch {
			return raw;
		}
		const t = evt.type as string | undefined;
		if (t === 'system' && evt.subtype === 'init') {
			const cwd = evt.cwd as string | undefined;
			return `[system] init (cwd=${cwd ?? '?'})`;
		}
		if (t === 'assistant') {
			const msg = (evt.message as { content?: Array<{ type: string; text?: string; name?: string; input?: unknown }> } | undefined)?.content;
			if (Array.isArray(msg)) {
				return msg
					.map((c) => {
						if (c.type === 'text') return `[assistant] ${c.text?.slice(0, 300) ?? ''}`;
						if (c.type === 'tool_use')
							return `[tool] ${c.name} ${JSON.stringify(c.input).slice(0, 200)}`;
						return `[${c.type}]`;
					})
					.join('\n');
			}
			return '[assistant] (empty)';
		}
		if (t === 'user') {
			const msg = (evt.message as { content?: Array<{ type: string; content?: string }> } | undefined)?.content;
			if (Array.isArray(msg)) {
				return msg
					.map((c) => `[tool-result] ${typeof c.content === 'string' ? c.content.slice(0, 300) : JSON.stringify(c.content).slice(0, 300)}`)
					.join('\n');
			}
			return '[user]';
		}
		if (t === 'result') {
			const cost = evt.total_cost_usd ?? (evt as { cost_usd?: number }).cost_usd;
			return `[result] ${evt.subtype ?? 'done'}${cost ? ` cost=$${cost}` : ''}`;
		}
		return raw;
	}

	onMount(() => {
		es = new EventSource('/api/stream');
		es.addEventListener('run:log', (e: MessageEvent) => {
			const { runId: rid, line } = JSON.parse(e.data);
			if (runId === null || rid === runId) {
				const formatted = pretty(line);
				if (formatted) lines = [...lines.slice(-199), formatted];
			}
		});
		es.addEventListener('run:finished', (e: MessageEvent) => {
			const { runId: rid, exitCode } = JSON.parse(e.data);
			if (runId === null || rid === runId)
				lines = [...lines, `--- finished exit=${exitCode} ---`];
		});
	});
	onDestroy(() => es?.close());
</script>

<pre class="bg-slate-900 border border-slate-800 rounded p-3 text-xs h-64 overflow-auto">{lines.join('\n')}</pre>
