<script lang="ts" module>
	import { marked } from 'marked';
	import DOMPurify from 'dompurify';

	marked.setOptions({ breaks: true, gfm: true });

	// Cache parsed markdown by source string so re-renders don't re-parse.
	const cache = new Map<string, string>();

	export function render(source: string): string {
		const hit = cache.get(source);
		if (hit !== undefined) return hit;
		const html = marked.parse(source) as string;
		const clean = DOMPurify.sanitize(html, {
			USE_PROFILES: { html: true },
			ADD_ATTR: ['target', 'rel'],
		});
		cache.set(source, clean);
		return clean;
	}
</script>

<script lang="ts">
	let {
		source,
		class: className = '',
	}: {
		source: string;
		class?: string;
	} = $props();

	const html = $derived(render(source));
</script>

<div class="prose prose-invert prose-sm max-w-none {className}">
	{@html html}
</div>

<style>
	/* Keep the rendered output from escaping its container on long lines */
	div :global(*) {
		min-width: 0;
	}
	div :global(pre) {
		overflow-x: auto;
		max-width: 100%;
	}
	div :global(code) {
		word-break: break-word;
	}
	div :global(a) {
		overflow-wrap: anywhere;
	}
</style>
