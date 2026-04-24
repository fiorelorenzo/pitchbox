<script lang="ts">
	import { Loader2 } from 'lucide-svelte';
	import { invalidateAll } from '$app/navigation';
	import { toast } from 'svelte-sonner';
	import { Button } from '$lib/components/ui/button';
	import { Badge } from '$lib/components/ui/badge';
	import { ScrollArea } from '$lib/components/ui/scroll-area';
	import * as Card from '$lib/components/ui/card';

	type Draft = {
		id: number;
		kind: string;
		targetUser: string | null;
		subreddit: string | null;
		fitScore: number | null;
		state: string;
		body: string;
		composeUrl: string | null;
		reasoning: string | null;
	};

	let { draft }: { draft: Draft | null } = $props();

	let approving = $state(false);
	let rejecting = $state(false);

	const KIND_BADGE_VARIANT: Record<string, 'default' | 'secondary' | 'outline'> = {
		dm: 'default',
		post: 'secondary',
		post_comment: 'outline',
		comment_reply: 'outline',
	};

	const STATE_BADGE_VARIANT: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> =
		{
			pending_review: 'secondary',
			approved: 'default',
			rejected: 'destructive',
		};

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
			toast.success('Draft approved');
		} catch (e) {
			toast.error('Approve failed');
		} finally {
			approving = false;
		}
	}

	async function reject() {
		rejecting = true;
		try {
			await patch({ state: 'rejected' });
			toast.success('Draft rejected');
		} catch (e) {
			toast.error('Reject failed');
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
		draft.kind === 'dm'
			? 'Open compose ↗'
			: draft.kind === 'post'
				? 'Open submit ↗'
				: 'Open post ↗'}

	<Card.Root class="h-full flex flex-col">
		<Card.Header class="flex-row items-start justify-between space-y-0 pb-3">
			<div class="space-y-1">
				<Card.Title class="text-base">{primary}</Card.Title>
				<div class="flex items-center gap-2 text-xs text-muted-foreground">
					<Badge variant={KIND_BADGE_VARIANT[draft.kind] ?? 'outline'} class="text-[10px]">
						{draft.kind}
					</Badge>
					<Badge variant={STATE_BADGE_VARIANT[draft.state] ?? 'secondary'} class="text-[10px]">
						{draft.state}
					</Badge>
					<span>fit {draft.fitScore ?? '?'}/5</span>
				</div>
			</div>
			<div class="flex gap-2">
				{#if draft.state === 'pending_review'}
					<Button onclick={approve} disabled={approving} variant="default" size="sm">
						{#if approving}<Loader2 class="size-4 animate-spin" />{/if}
						Approve
					</Button>
					<Button onclick={reject} disabled={rejecting} variant="destructive" size="sm">
						{#if rejecting}<Loader2 class="size-4 animate-spin" />{/if}
						Reject
					</Button>
				{/if}
				{#if draft.state === 'approved' && draft.composeUrl}
					<a
						href={`${draft.composeUrl}${urlSep}pitchbox_draft=${draft.id}`}
						target="_blank"
						rel="noopener"
						class="inline-flex items-center gap-2 px-3 py-1.5 text-sm font-medium rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
					>
						{openLabel}
					</a>
				{/if}
			</div>
		</Card.Header>
		<Card.Content class="flex-1 overflow-hidden flex flex-col gap-3">
			<ScrollArea class="flex-1 rounded border bg-muted/30 p-4">
				<pre class="whitespace-pre-wrap text-sm font-sans">{draft.body}</pre>
			</ScrollArea>
			{#if draft.reasoning}
				<p class="text-xs text-muted-foreground">
					<strong>Why it fits:</strong>
					{draft.reasoning}
				</p>
			{/if}
		</Card.Content>
	</Card.Root>
{:else}
	<div class="h-full flex items-center justify-center text-muted-foreground text-sm">
		Select a draft
	</div>
{/if}
