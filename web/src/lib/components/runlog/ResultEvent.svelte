<script lang="ts">
	import { CheckCircle2, XCircle } from 'lucide-svelte';
	import { formatDuration } from '$lib/utils/time';

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

	function formatTokens(n: number | undefined): string {
		if (n == null) return '—';
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
			<CheckCircle2 class="size-4 text-green-400 shrink-0" />
			<span class="text-sm font-semibold text-green-400">Run succeeded</span>
		{:else}
			<XCircle class="size-4 text-destructive shrink-0" />
			<span class="text-sm font-semibold text-destructive">Run failed</span>
		{/if}
	</div>

	<!-- Meta row -->
	<div class="flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-muted-foreground mb-2">
		{#if data.inputTokens != null || data.outputTokens != null}
			<span>{formatTokens(data.inputTokens)} → {formatTokens(data.outputTokens)} tokens</span>
		{/if}
		{#if data.totalCostUsd != null}
			<span class="font-medium text-foreground/70">{formatCost(data.totalCostUsd)}</span>
		{/if}
		{#if data.durationMs != null}
			<span>{formatDuration(data.durationMs)}</span>
		{/if}
		{#if data.numTurns != null}
			<span>{data.numTurns} turns</span>
		{/if}
	</div>

	<!-- Body prose -->
	{#if data.text}
		<p class="text-sm whitespace-pre-wrap break-words leading-relaxed text-foreground/80 min-w-0">
			{data.text}
		</p>
	{/if}
</div>
