<svelte:options runes={false} />

<script lang="ts">
	import DraftListItem from '$lib/components/DraftListItem.svelte';
	import DraftDetail from '$lib/components/DraftDetail.svelte';
	import { onMount } from 'svelte';
	import { invalidateAll, goto } from '$app/navigation';
	import { page } from '$app/stores';

	export let data: { drafts: any[]; state: string; kind: string | null };

	let selectedId: number | null = data.drafts[0]?.id ?? null;
	$: selected = data.drafts.find((d) => d.id === selectedId) ?? null;

	const KINDS = [
		{ value: null, label: 'All' },
		{ value: 'dm', label: 'DMs' },
		{ value: 'post', label: 'Posts' },
		{ value: 'post_comment', label: 'Comments' },
		{ value: 'comment_reply', label: 'Replies' },
	];

	function setKind(kind: string | null) {
		const url = new URL($page.url);
		if (kind) url.searchParams.set('kind', kind);
		else url.searchParams.delete('kind');
		goto(url.pathname + url.search, { invalidateAll: true, replaceState: true });
	}

	onMount(() => {
		const es = new EventSource('/api/stream');
		es.addEventListener('drafts:changed', () => invalidateAll());
		return () => es.close();
	});
</script>

<div class="mb-3 flex gap-1 text-xs">
	{#each KINDS as k (k.label)}
		<button
			class="px-2 py-1 rounded border border-slate-800"
			class:bg-slate-800={data.kind === k.value}
			on:click={() => setKind(k.value)}>{k.label}</button
		>
	{/each}
</div>

<div class="grid grid-cols-[360px_1fr] gap-4 h-[calc(100vh-5rem)]">
	<aside class="border border-slate-800 rounded overflow-auto">
		{#if data.drafts.length === 0}
			<p class="p-4 text-sm text-slate-500">No drafts in state "{data.state}".</p>
		{/if}
		{#each data.drafts as draft (draft.id)}
			<DraftListItem {draft} selected={draft.id === selectedId} on:click={() => (selectedId = draft.id)} />
		{/each}
	</aside>
	<section class="border border-slate-800 rounded p-4 overflow-auto">
		<DraftDetail draft={selected} />
	</section>
</div>
