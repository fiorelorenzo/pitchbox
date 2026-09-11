<script lang="ts">
	import { CheckCircle2, XCircle } from '@lucide/svelte';
	import { page } from '$app/stores';
	import { formatDuration } from '$lib/utils/time';
	import { TONE_TEXT_CLASS } from '$lib/config/status-badges';
	import Markdown from '$lib/components/Markdown.svelte';
	import { t, tn, type Locale } from '$lib/i18n/index.js';

	let {
		data,
	}: {
		data: {
			success: boolean;
			text?: string;
			inputTokens?: number;
			outputTokens?: number;
			totalCostUsd?: number;
			durationMs?: number;
			numTurns?: number;
		};
	} = $props();

	const locale = $derived($page.data.locale as Locale);

	function formatTokens(n: number | undefined): string {
		if (n == null) return '-';
		return n.toLocaleString();
	}

	function formatCost(usd: number | undefined): string {
		if (usd == null) return '';
		return `$${usd.toFixed(4)}`;
	}
</script>

<div class="min-w-0">
	<!-- Title -->
	<div class="flex items-center gap-2 mb-2">
		{#if data.success}
			<CheckCircle2 class="size-4 {TONE_TEXT_CLASS.emerald} shrink-0" />
			<span class="text-sm font-semibold {TONE_TEXT_CLASS.emerald}"
				>{t(locale, 'runlog.run-succeeded')}</span
			>
		{:else}
			<XCircle class="size-4 text-destructive shrink-0" />
			<span class="text-sm font-semibold text-destructive">{t(locale, 'runlog.run-failed')}</span>
		{/if}
	</div>

	<!-- Meta row -->
	<div class="flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-muted-foreground mb-2">
		{#if data.inputTokens != null || data.outputTokens != null}
			<span
				>{t(locale, 'runlog.tokens', {
					input: formatTokens(data.inputTokens),
					output: formatTokens(data.outputTokens),
				})}</span
			>
		{/if}
		{#if data.totalCostUsd != null}
			<span class="font-medium text-foreground/70">{formatCost(data.totalCostUsd)}</span>
		{/if}
		{#if data.durationMs != null}
			<span>{formatDuration(data.durationMs, locale)}</span>
		{/if}
		{#if data.numTurns != null}
			<span>{tn(locale, 'runlog.turns-count', data.numTurns)}</span>
		{/if}
	</div>

	<!-- Body prose (markdown) -->
	{#if data.text}
		<Markdown source={data.text} class="text-foreground/80 leading-relaxed" />
	{/if}
</div>
