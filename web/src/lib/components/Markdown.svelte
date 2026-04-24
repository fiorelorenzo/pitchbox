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
		color: var(--color-primary, #818cf8);
		text-decoration: underline;
		text-underline-offset: 2px;
	}

	/* Headings */
	div :global(h1) {
		font-size: 1.125rem;
		font-weight: 600;
		margin: 0.75rem 0 0.5rem;
	}
	div :global(h2) {
		font-size: 1rem;
		font-weight: 600;
		margin: 0.625rem 0 0.375rem;
	}
	div :global(h3),
	div :global(h4) {
		font-size: 0.9375rem;
		font-weight: 600;
		margin: 0.5rem 0 0.25rem;
	}

	/* Paragraphs & lists */
	div :global(p) {
		margin: 0.5rem 0;
		line-height: 1.55;
	}
	div :global(ul),
	div :global(ol) {
		margin: 0.5rem 0;
		padding-left: 1.25rem;
	}
	div :global(ul) {
		list-style: disc;
	}
	div :global(ol) {
		list-style: decimal;
	}
	div :global(li) {
		margin: 0.2rem 0;
	}

	/* Inline code */
	div :global(:not(pre) > code) {
		background: color-mix(in srgb, currentColor 12%, transparent);
		padding: 0.1em 0.35em;
		border-radius: 0.25rem;
		font-size: 0.85em;
	}
	div :global(pre) {
		background: color-mix(in srgb, currentColor 8%, transparent);
		padding: 0.75rem;
		border-radius: 0.375rem;
		font-size: 0.8125rem;
		line-height: 1.5;
	}

	/* Blockquote */
	div :global(blockquote) {
		border-left: 2px solid color-mix(in srgb, currentColor 30%, transparent);
		padding-left: 0.75rem;
		margin: 0.5rem 0;
		color: color-mix(in srgb, currentColor 75%, transparent);
	}

	/* Tables: shrink to content width, never wider than container */
	div :global(table) {
		width: fit-content;
		max-width: 100%;
		border-collapse: collapse;
		margin: 0.75rem 0;
		font-size: 0.8125rem;
		border: 1px solid color-mix(in srgb, currentColor 18%, transparent);
		border-radius: 0.375rem;
		overflow: hidden;
	}
	div :global(thead) {
		background: color-mix(in srgb, currentColor 8%, transparent);
	}
	div :global(th) {
		text-align: left;
		font-weight: 600;
		padding: 0.4rem 0.65rem;
		border-bottom: 1px solid color-mix(in srgb, currentColor 18%, transparent);
		border-right: 1px solid color-mix(in srgb, currentColor 12%, transparent);
	}
	div :global(td) {
		padding: 0.35rem 0.65rem;
		border-bottom: 1px solid color-mix(in srgb, currentColor 10%, transparent);
		border-right: 1px solid color-mix(in srgb, currentColor 8%, transparent);
		vertical-align: top;
	}
	div :global(th:last-child),
	div :global(td:last-child) {
		border-right: none;
	}
	div :global(tbody tr:last-child td) {
		border-bottom: none;
	}
	div :global(tbody tr:hover) {
		background: color-mix(in srgb, currentColor 5%, transparent);
	}

	/* Horizontal rule */
	div :global(hr) {
		border: 0;
		border-top: 1px solid color-mix(in srgb, currentColor 18%, transparent);
		margin: 1rem 0;
	}

	/* Strong / em */
	div :global(strong) {
		font-weight: 600;
	}
	div :global(em) {
		font-style: italic;
	}
</style>
