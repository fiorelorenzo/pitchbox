<script lang="ts">
	import { cn } from '$lib/utils';
	import { relativeTime } from '$lib/utils/time';
	import StatusBadge from '$lib/components/StatusBadge.svelte';

	type Draft = {
		id: number;
		kind: string;
		targetUser: string | null;
		subreddit: string | null;
		fitScore: number | null;
		state: string;
		createdAt: string | Date | null;
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
</script>

<button
	class={cn(
		'w-full text-left p-3 border-b border-border/60 transition-colors',
		selected && 'text-foreground',
	)}
	{onclick}
>
	<div class="flex justify-between items-center gap-2">
		<span class="font-medium text-sm truncate">
			{#if draft.kind === 'dm'}u/{draft.targetUser ?? '—'}{:else}r/{draft.subreddit ?? '—'}{/if}
		</span>
		<StatusBadge domain="draft-kind" value={draft.kind} class="shrink-0" />
	</div>
	<div class="text-xs text-muted-foreground mt-1 flex items-center gap-1.5">
		<StatusBadge domain="draft-state" value={draft.state} />
		<span>· fit {draft.fitScore ?? '?'}/5</span>
		{#if draft.kind !== 'dm' && draft.subreddit == null && draft.targetUser}
			<span>· u/{draft.targetUser}</span>
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
