<svelte:options runes={false} />

<script lang="ts">
	export let draft: {
		id: number;
		kind: string;
		targetUser: string | null;
		subreddit: string | null;
		fitScore: number | null;
		state: string;
		createdAt: string;
	};
	export let selected = false;

	const KIND_LABEL: Record<string, string> = {
		dm: 'DM',
		post: 'Post',
		post_comment: 'Comment',
		comment_reply: 'Reply',
	};
</script>

<button
	class="w-full text-left p-3 border-b border-slate-800 hover:bg-slate-900"
	class:bg-slate-900={selected}
	on:click
>
	<div class="flex justify-between items-center">
		<span class="font-medium">
			{#if draft.kind === 'dm'}u/{draft.targetUser ?? '—'}{:else}r/{draft.subreddit ?? '—'}{/if}
		</span>
		<span class="text-xs px-1.5 py-0.5 rounded bg-slate-800 text-slate-300">
			{KIND_LABEL[draft.kind] ?? draft.kind}
		</span>
	</div>
	<div class="text-xs text-slate-400 mt-1">
		fit {draft.fitScore ?? '?'}/5 · {draft.state}
		{#if draft.kind !== 'dm' && draft.subreddit == null && draft.targetUser}· u/{draft.targetUser}{/if}
	</div>
</button>
