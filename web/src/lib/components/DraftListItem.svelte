<script lang="ts">
	import { cn } from '$lib/utils';
	import { relativeTime } from '$lib/utils/time';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import { getPresenter } from '$lib/platforms/presenter';
	import { scoreBand, DEFAULT_QUALITY_RUBRIC, type QualityRubric } from '@pitchbox/shared/quality-judge';
	import { TONE_CLASS, type Tone } from '$lib/config/status-badges';

	// scoreBand's band names are a shared-package contract (not the design
	// registry's Tone names), so translate here rather than renaming the shared
	// export.
	const BAND_TONE: Record<'red' | 'amber' | 'green', Tone> = {
		red: 'rose',
		amber: 'amber',
		green: 'emerald',
	};

	type Draft = {
		id: number;
		kind: string;
		title?: string | null;
		targetUser: string | null;
		platformSlug: string | null;
		metadata: Record<string, unknown> | null;
		fitScore: number | null;
		state: string;
		createdAt: string | Date | null;
		project?: { id: number; slug: string; name: string };
		dedupWarning?: string | null;
		qualityScore?: number | null;
		variantGroupId?: string | null;
		variantLabel?: string | null;
		scheduledSendAfter?: string | Date | null;
	};

	let {
		draft,
		rubric = DEFAULT_QUALITY_RUBRIC,
		selected = false,
		runId,
		onclick,
	}: {
		draft: Draft;
		rubric?: QualityRubric;
		selected?: boolean;
		runId?: number;
		onclick?: () => void;
	} = $props();

	const presenter = $derived(getPresenter(draft.platformSlug));
	const band = $derived(scoreBand(draft.qualityScore, rubric));
	// Mirrors DraftDetail's scheduledUntil: only a future scheduled_send_after
	// is worth flagging - a past one no longer blocks the send.
	const scheduledUntil = $derived.by(() => {
		if (!draft.scheduledSendAfter) return null;
		const when = new Date(draft.scheduledSendAfter);
		return when.getTime() > Date.now() ? when : null;
	});
</script>

<button
	class={cn(
		'w-full text-left p-3 border-b border-border/60 transition-colors',
		selected && 'text-foreground',
	)}
	{onclick}
>
	<div class="flex justify-between items-center gap-2">
		<span class="font-medium text-sm truncate flex items-center gap-1.5">
			{presenter.primaryLabel(draft)}
			{#if draft.variantLabel}
				<span
					class="inline-flex items-center rounded-sm px-1 py-0.5 text-[10px] font-medium bg-indigo-100 text-indigo-900 dark:bg-indigo-950 dark:text-indigo-200"
					title="A/B variant {draft.variantLabel}"
				>
					{draft.variantLabel}
				</span>
			{/if}
			{#if band !== 'none'}
				<span
					class="inline-flex items-center rounded-sm px-1 py-0.5 text-[10px] font-medium {TONE_CLASS[BAND_TONE[band as 'red' | 'amber' | 'green']]}"
					title="Quality score (LLM judge)"
				>
					Q{draft.qualityScore}
				</span>
			{/if}
			{#if draft.dedupWarning}
				<span
					class="inline-flex items-center rounded-sm px-1 py-0.5 text-[10px] font-medium {TONE_CLASS.amber}"
					title={draft.dedupWarning}
				>
					dedup
				</span>
			{/if}
			{#if scheduledUntil}
				<span
					class="inline-flex items-center rounded-sm px-1 py-0.5 text-[10px] font-medium {TONE_CLASS.amber}"
					title="Scheduled until {scheduledUntil.toLocaleString()}"
				>
					scheduled
				</span>
			{/if}
		</span>
		<StatusBadge domain="draft-kind" value={draft.kind} class="shrink-0" />
	</div>
	{#if draft.kind === 'post' && draft.title}
		<div class="text-xs text-foreground/90 truncate mt-0.5" title={draft.title}>
			{draft.title}
		</div>
	{/if}
	{#if draft.project}
		<div class="text-[10px] text-muted-foreground/70 truncate mt-0.5">
			{draft.project.name}
		</div>
	{/if}
	<div class="text-xs text-muted-foreground mt-1 flex items-center gap-1.5">
		<StatusBadge domain="draft-state" value={draft.state} />
		{#if draft.fitScore != null}
			<span>· fit {draft.fitScore}/5</span>
		{/if}
	</div>
	{#if runId != null || draft.createdAt}
		<div class="text-[10px] text-muted-foreground/70 mt-0.5 flex items-center gap-1">
			{#if runId != null}
				<a
					href="/inbox?run={runId}"
					onclick={(e) => e.stopPropagation()}
					class="hover:underline hover:text-muted-foreground"
				>
					Run #{runId}
				</a>
				{#if draft.createdAt}
					<span>·</span>
				{/if}
			{/if}
			{#if draft.createdAt}
				<span>{relativeTime(draft.createdAt)}</span>
			{/if}
		</div>
	{/if}
</button>
