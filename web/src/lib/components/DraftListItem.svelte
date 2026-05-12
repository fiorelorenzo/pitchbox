<script lang="ts">
	import { cn } from '$lib/utils';
	import { relativeTime } from '$lib/utils/time';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import { getPresenter } from '$lib/platforms/presenter';

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
	};

	let {
		draft,
		selected = false,
		runId,
		onclick,
	}: {
		draft: Draft;
		selected?: boolean;
		runId?: number;
		onclick?: () => void;
	} = $props();

	const presenter = $derived(getPresenter(draft.platformSlug));
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
			{#if draft.dedupWarning}
				<span
					class="inline-flex items-center rounded-sm px-1 py-0.5 text-[10px] font-medium bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200"
					title={draft.dedupWarning}
				>
					dedup
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
		<span>· fit {draft.fitScore ?? '?'}/5</span>
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
