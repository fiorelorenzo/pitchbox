<script lang="ts">
	import { Badge } from '$lib/components/ui/badge';
	import { cn } from '$lib/utils';
	import { relativeTime } from '$lib/utils/time';

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
	}: { draft: Draft; selected?: boolean; runId?: number; onclick?: () => void } = $props();

	const KIND_LABEL: Record<string, string> = {
		dm: 'DM',
		post: 'Post',
		post_comment: 'Comment',
		comment_reply: 'Reply',
	};

	const KIND_BADGE_VARIANT: Record<string, 'default' | 'secondary' | 'outline'> = {
		dm: 'default',
		post: 'secondary',
		post_comment: 'outline',
		comment_reply: 'outline',
	};
</script>

<button
	class={cn(
		'w-full text-left p-3 border-b border-border hover:bg-accent/50 transition-colors',
		selected && 'bg-accent'
	)}
	{onclick}
>
	<div class="flex justify-between items-center gap-2">
		<span class="font-medium text-sm truncate">
			{#if draft.kind === 'dm'}u/{draft.targetUser ?? '—'}{:else}r/{draft.subreddit ?? '—'}{/if}
		</span>
		<Badge variant={KIND_BADGE_VARIANT[draft.kind] ?? 'outline'} class="text-[10px] shrink-0">
			{KIND_LABEL[draft.kind] ?? draft.kind}
		</Badge>
	</div>
	<div class="text-xs text-muted-foreground mt-1">
		fit {draft.fitScore ?? '?'}/5 · {draft.state}
		{#if draft.kind !== 'dm' && draft.subreddit == null && draft.targetUser}· u/{draft.targetUser}{/if}
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
