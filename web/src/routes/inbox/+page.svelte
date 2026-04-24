<script lang="ts">
	import DraftListItem from '$lib/components/DraftListItem.svelte';
	import DraftDetail from '$lib/components/DraftDetail.svelte';
	import { onMount } from 'svelte';
	import { invalidateAll, goto } from '$app/navigation';
	import { page } from '$app/stores';
	import { ChevronDown } from 'lucide-svelte';
	import { Button } from '$lib/components/ui/button';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import * as Card from '$lib/components/ui/card';

	let { data }: { data: { drafts: any[]; state: string; kind: string | null } } = $props();

	let selectedId = $derived<number | null>(data.drafts[0]?.id ?? null);
	let selected = $derived(data.drafts.find((d) => d.id === selectedId) ?? null);

	const KINDS = [
		{ value: null, label: 'All' },
		{ value: 'dm', label: 'DMs' },
		{ value: 'post', label: 'Posts' },
		{ value: 'post_comment', label: 'Comments' },
		{ value: 'comment_reply', label: 'Replies' },
	];

	let kindLabel = $derived(KINDS.find((k) => k.value === data.kind)?.label ?? 'All');

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

<div class="mb-3 flex items-center gap-2">
	<DropdownMenu.Root>
		<DropdownMenu.Trigger>
			{#snippet child({ props })}
				<Button {...props} variant="outline" size="sm">
					Kind: {kindLabel}
					<ChevronDown class="ml-1 size-3" />
				</Button>
			{/snippet}
		</DropdownMenu.Trigger>
		<DropdownMenu.Content align="start">
			{#each KINDS as k (k.label)}
				<DropdownMenu.Item onclick={() => setKind(k.value)}>
					{k.label}
				</DropdownMenu.Item>
			{/each}
		</DropdownMenu.Content>
	</DropdownMenu.Root>
</div>

<Card.Root class="grid grid-cols-[360px_1fr] h-[calc(100vh-8rem)] overflow-hidden">
	<aside class="border-r border-border overflow-auto">
		{#if data.drafts.length === 0}
			<p class="p-4 text-sm text-muted-foreground">No drafts in state "{data.state}".</p>
		{/if}
		{#each data.drafts as draft (draft.id)}
			<DraftListItem {draft} selected={draft.id === selectedId} onclick={() => (selectedId = draft.id)} />
		{/each}
	</aside>
	<section class="p-4 overflow-auto">
		<DraftDetail draft={selected} />
	</section>
</Card.Root>
