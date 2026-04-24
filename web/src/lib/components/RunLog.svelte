<svelte:options runes={false} />

<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	export let runId: number | null = null;

	let lines: string[] = [];
	let es: EventSource | null = null;

	onMount(() => {
		es = new EventSource('/api/stream');
		es.addEventListener('run:log', (e: MessageEvent) => {
			const { runId: rid, line } = JSON.parse(e.data);
			if (runId === null || rid === runId) lines = [...lines.slice(-199), line];
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
