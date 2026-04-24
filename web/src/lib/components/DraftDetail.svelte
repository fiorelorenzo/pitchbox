<svelte:options runes={false} />

<script lang="ts">
	import SpinnerButton from './SpinnerButton.svelte';
	import { invalidateAll } from '$app/navigation';

	export let draft: {
		id: number;
		kind: string;
		targetUser: string | null;
		subreddit: string | null;
		fitScore: number | null;
		state: string;
		body: string;
		composeUrl: string | null;
		reasoning: string | null;
	} | null;

	let approving = false;
	let rejecting = false;

	async function patch(body: Record<string, unknown>) {
		const res = await fetch(`/inbox/${draft!.id}`, {
			method: 'PATCH',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body),
		});
		if (!res.ok) throw new Error(await res.text());
		await invalidateAll();
	}

	async function approve() {
		approving = true;
		try {
			await patch({ state: 'approved' });
		} finally {
			approving = false;
		}
	}

	async function reject() {
		rejecting = true;
		try {
			await patch({ state: 'rejected' });
		} finally {
			rejecting = false;
		}
	}
</script>

{#if draft}
	{@const primary =
		draft.kind === 'dm' ? `u/${draft.targetUser ?? '—'}` : `r/${draft.subreddit ?? '—'}`}
	{@const urlSep = draft.composeUrl?.includes('?') ? '&' : '?'}
	{@const openLabel =
		draft.kind === 'dm' ? 'Open compose ↗' : draft.kind === 'post' ? 'Open submit ↗' : 'Open post ↗'}
	<div class="h-full flex flex-col">
		<header class="flex justify-between items-start mb-4">
			<div>
				<h2 class="text-lg font-semibold">{primary}</h2>
				<p class="text-xs text-slate-400">
					{draft.kind} · fit {draft.fitScore ?? '?'}/5 · {draft.state}
				</p>
			</div>
			<div class="flex gap-2">
				{#if draft.state === 'pending_review'}
					<SpinnerButton loading={approving} on:click={approve}>Approve</SpinnerButton>
					<SpinnerButton loading={rejecting} variant="danger" on:click={reject}>Reject</SpinnerButton>
				{/if}
				{#if draft.state === 'approved' && draft.composeUrl}
					<a
						href={`${draft.composeUrl}${urlSep}pitchbox_draft=${draft.id}`}
						target="_blank"
						rel="noopener"
						class="px-3 py-1.5 rounded text-sm bg-emerald-600 hover:bg-emerald-500">{openLabel}</a
					>
				{/if}
			</div>
		</header>
		<section
			class="prose prose-invert max-w-none whitespace-pre-wrap text-sm bg-slate-900 p-4 rounded border border-slate-800 flex-1 overflow-auto"
			>{draft.body}</section
		>
		{#if draft.reasoning}
			<section class="mt-3 text-xs text-slate-400">
				<strong>Why it fits:</strong>
				{draft.reasoning}
			</section>
		{/if}
	</div>
{:else}
	<div class="h-full flex items-center justify-center text-slate-500">Select a draft</div>
{/if}
