<script lang="ts">
	import { Clipboard, Check } from 'lucide-svelte';
	import { invalidateAll } from '$app/navigation';
	import { toast } from 'svelte-sonner';
	import { Button } from '$lib/components/ui/button';
	import { Badge } from '$lib/components/ui/badge';
	import { ScrollArea } from '$lib/components/ui/scroll-area';
	import * as Card from '$lib/components/ui/card';
	import * as Tabs from '$lib/components/ui/tabs';
	import { relativeTime } from '$lib/utils/time';

	type DraftEvent = {
		id: number;
		event: string;
		actor: string;
		createdAt: string | Date;
	};

	type Draft = {
		id: number;
		runId: number;
		kind: string;
		targetUser: string | null;
		subreddit: string | null;
		fitScore: number | null;
		state: string;
		body: string;
		composeUrl: string | null;
		reasoning: string | null;
		createdAt: string | Date | null;
		sentAt: string | Date | null;
		sentContent: string | null;
	};

	let { draft }: { draft: Draft | null } = $props();

	let approving = $state(false);
	let rejecting = $state(false);
	let copied = $state(false);
	let events = $state<DraftEvent[]>([]);
	let loadingEvents = $state(false);

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

	$effect(() => {
		if (!draft) {
			events = [];
			return;
		}
		const draftId = draft.id;
		loadingEvents = true;
		fetch(`/inbox/${draftId}/events`)
			.then((r) => r.json())
			.then((data) => {
				events = data;
			})
			.catch(() => {
				events = [];
			})
			.finally(() => {
				loadingEvents = false;
			});
	});

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
			toast.success('Approved', { description: 'Open compose to send it.' });
		} catch (e) {
			toast.error('Action failed', { description: (e as Error).message });
		} finally {
			approving = false;
		}
	}

	async function reject() {
		rejecting = true;
		try {
			await patch({ state: 'rejected' });
			toast.success('Rejected');
		} catch (e) {
			toast.error('Action failed', { description: (e as Error).message });
		} finally {
			rejecting = false;
		}
	}

	async function copyBody() {
		if (!draft) return;
		await navigator.clipboard.writeText(draft.body);
		copied = true;
		toast.success('Copied to clipboard');
		setTimeout(() => (copied = false), 2000);
	}

	let hasSentVariant = $derived(
		draft?.sentContent != null && draft.sentContent !== draft.body
	);

	const EVENT_LABEL: Record<string, string> = {
		created: 'Created',
		approved: 'Approved',
		rejected: 'Rejected',
		sent: 'Sent',
		edited: 'Edited',
	};
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
				<div class="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
					<Badge variant={KIND_BADGE_VARIANT[draft.kind] ?? 'outline'} class="text-[10px]">
						{draft.kind}
					</Badge>
					<Badge variant={STATE_BADGE_VARIANT[draft.state] ?? 'secondary'} class="text-[10px]">
						{draft.state}
					</Badge>
					<span>fit {draft.fitScore ?? '?'}/5</span>
					<a href="/inbox?run={draft.runId}" class="hover:underline text-muted-foreground">
						<Badge variant="outline" class="text-[10px]">Run #{draft.runId}</Badge>
					</a>
					{#if draft.createdAt}
						<span>{relativeTime(draft.createdAt)}</span>
					{/if}
					{#if draft.sentAt}
						<span>· sent {relativeTime(draft.sentAt)}</span>
					{/if}
				</div>
			</div>
			<div class="flex gap-2 flex-wrap justify-end">
				<Button onclick={copyBody} variant="outline" size="sm" aria-label="Copy body to clipboard">
					{#if copied}
						<Check class="size-3.5" />
					{:else}
						<Clipboard class="size-3.5" />
					{/if}
				</Button>
				{#if draft.state === 'pending_review'}
					<Button onclick={approve} loading={approving} variant="default" size="sm">
						Approve
					</Button>
					<Button onclick={reject} loading={rejecting} variant="destructive" size="sm">
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
			{#if hasSentVariant}
				<Tabs.Root value="drafted" class="flex-1 flex flex-col min-h-0">
					<Tabs.List class="w-fit">
						<Tabs.Trigger value="drafted">Drafted</Tabs.Trigger>
						<Tabs.Trigger value="sent">Sent</Tabs.Trigger>
					</Tabs.List>
					<Tabs.Content value="drafted" class="flex-1 min-h-0">
						<ScrollArea class="h-full rounded border bg-muted/30 p-4">
							<pre class="whitespace-pre-wrap text-sm font-sans">{draft.body}</pre>
						</ScrollArea>
					</Tabs.Content>
					<Tabs.Content value="sent" class="flex-1 min-h-0">
						<ScrollArea class="h-full rounded border bg-muted/30 p-4">
							<pre class="whitespace-pre-wrap text-sm font-sans">{draft.sentContent}</pre>
						</ScrollArea>
					</Tabs.Content>
				</Tabs.Root>
			{:else}
				<ScrollArea class="flex-1 rounded border bg-muted/30 p-4">
					<pre class="whitespace-pre-wrap text-sm font-sans">{draft.body}</pre>
				</ScrollArea>
			{/if}
			{#if draft.reasoning}
				<p class="text-xs text-muted-foreground">
					<strong>Why it fits:</strong>
					{draft.reasoning}
				</p>
			{/if}
			<!-- Event timeline -->
			{#if events.length > 0}
				<div class="border-t pt-3">
					<p class="text-xs font-medium text-muted-foreground mb-2 uppercase tracking-wide">Timeline</p>
					<ol class="relative pl-4 border-l border-border space-y-2">
						{#each events as ev (ev.id)}
							<li class="relative">
								<span
									class="absolute -left-[17px] top-1 size-2 rounded-full bg-muted-foreground/40 border border-background"
								></span>
								<div class="flex items-baseline gap-1.5">
									<span class="text-xs font-medium">{EVENT_LABEL[ev.event] ?? ev.event}</span>
									<span class="text-[10px] text-muted-foreground">by {ev.actor}</span>
									<span class="text-[10px] text-muted-foreground ml-auto"
										>{relativeTime(ev.createdAt)}</span
									>
								</div>
							</li>
						{/each}
					</ol>
				</div>
			{:else if loadingEvents}
				<div class="text-xs text-muted-foreground">Loading timeline…</div>
			{/if}
		</Card.Content>
	</Card.Root>
{:else}
	<div class="h-full flex items-center justify-center text-muted-foreground text-sm">
		Select a draft
	</div>
{/if}
