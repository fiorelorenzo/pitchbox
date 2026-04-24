<script lang="ts">
	import { Clipboard, Check, Send, ExternalLink, MessageSquare } from 'lucide-svelte';
	import { invalidateAll } from '$app/navigation';
	import { toast } from 'svelte-sonner';
	import { Button } from '$lib/components/ui/button';
	import { Badge } from '$lib/components/ui/badge';
	import { ScrollArea } from '$lib/components/ui/scroll-area';
	import { Textarea } from '$lib/components/ui/textarea';
	import * as Tabs from '$lib/components/ui/tabs';
	import * as Dialog from '$lib/components/ui/dialog';
	import { relativeTime } from '$lib/utils/time';
	import Markdown from '$lib/components/Markdown.svelte';
	import StatusBadge from '$lib/components/StatusBadge.svelte';

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

	type LatestReply = { body: string; author: string; createdAt: string | Date } | null;

	let approving = $state(false);
	let rejecting = $state(false);
	let copied = $state(false);
	let events = $state<DraftEvent[]>([]);
	let loadingEvents = $state(false);
	let latestReply = $state<LatestReply>(null);

	// Mark-as-sent dialog
	let sendDialogOpen = $state(false);
	let sendingNow = $state(false);
	let sentDraftText = $state('');

	$effect(() => {
		if (!draft) {
			events = [];
			latestReply = null;
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
		fetch(`/inbox/${draftId}/reply`)
			.then((r) => r.json())
			.then((data: LatestReply) => {
				latestReply = data;
			})
			.catch(() => {
				latestReply = null;
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

	function openSendDialog() {
		sentDraftText = draft?.body ?? '';
		sendDialogOpen = true;
	}

	async function confirmSent() {
		if (!draft) return;
		sendingNow = true;
		try {
			await patch({ state: 'sent', sentContent: sentDraftText });
			toast.success('Marked as sent');
			sendDialogOpen = false;
		} catch (e) {
			toast.error('Action failed', { description: (e as Error).message });
		} finally {
			sendingNow = false;
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
		replied: 'Replied',
		armed: 'Send clicked on Reddit',
	};

	let editedFromDraft = $derived(draft != null && sentDraftText !== draft.body);
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

	<article class="h-full flex flex-col min-h-0">
		<!-- Header: borderless, generous spacing -->
		<header class="flex flex-wrap items-start justify-between gap-3 pb-4 border-b border-border">
			<div class="flex flex-col gap-1.5 min-w-0">
				<h2 class="text-lg font-semibold truncate">{primary}</h2>
				<div class="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
					<StatusBadge domain="draft-kind" value={draft.kind} />
					<StatusBadge domain="draft-state" value={draft.state} />
					<span class="text-muted-foreground/40">·</span>
					<span>fit {draft.fitScore ?? '?'}/5</span>
					<span class="text-muted-foreground/40">·</span>
					<a href="/inbox?run={draft.runId}" class="hover:text-foreground transition-colors">
						run #{draft.runId}
					</a>
					{#if draft.createdAt}
						<span class="text-muted-foreground/40">·</span>
						<span>{relativeTime(draft.createdAt)}</span>
					{/if}
					{#if draft.sentAt}
						<span class="text-muted-foreground/40">·</span>
						<span>sent {relativeTime(draft.sentAt)}</span>
					{/if}
				</div>
			</div>
			<div class="flex gap-2 flex-wrap justify-end shrink-0">
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
					<Button
						href={`${draft.composeUrl}${urlSep}pitchbox_draft=${draft.id}`}
						target="_blank"
						rel="noopener"
						size="sm"
					>
						<ExternalLink class="size-3.5" />
						{openLabel.replace(' ↗', '')}
					</Button>
				{/if}
				{#if draft.state === 'approved'}
					<Button onclick={openSendDialog} variant="outline" size="sm">
						<Send class="size-3.5" />
						Mark as sent
					</Button>
				{/if}
			</div>
		</header>

		<!-- Body -->
		<div class="flex-1 min-h-0 flex flex-col gap-4 py-4">
			{#if hasSentVariant}
				<Tabs.Root value="drafted" class="flex-1 flex flex-col min-h-0">
					<Tabs.List class="w-fit">
						<Tabs.Trigger value="drafted">Drafted</Tabs.Trigger>
						<Tabs.Trigger value="sent">Sent</Tabs.Trigger>
					</Tabs.List>
					<Tabs.Content value="drafted" class="flex-1 min-h-0 mt-2">
						<ScrollArea class="h-full rounded-lg border border-border/60 bg-muted/20 p-4">
							<Markdown source={draft.body} />
						</ScrollArea>
					</Tabs.Content>
					<Tabs.Content value="sent" class="flex-1 min-h-0 mt-2">
						<ScrollArea class="h-full rounded-lg border border-border/60 bg-muted/20 p-4">
							<Markdown source={draft.sentContent ?? ''} />
						</ScrollArea>
					</Tabs.Content>
				</Tabs.Root>
			{:else}
				<ScrollArea class="flex-1 rounded-lg border border-border/60 bg-muted/20 p-4">
					<Markdown source={draft.body} />
				</ScrollArea>
			{/if}

			{#if draft.reasoning}
				<div
					class="rounded-lg bg-muted/10 border-l-2 border-primary/40 px-3 py-2 text-xs text-muted-foreground"
				>
					<span class="font-medium text-foreground/70">Why it fits. </span>
					{draft.reasoning}
				</div>
			{/if}

			{#if latestReply}
				<div class="rounded-lg border-l-2 border-violet-400/60 bg-muted/40 p-3">
					<div class="flex items-start justify-between gap-3">
						<p class="text-[10px] uppercase tracking-wide text-muted-foreground">
							Reply from u/{latestReply.author}
						</p>
						<Button
							href={`https://chat.reddit.com/user/${latestReply.author}`}
							target="_blank"
							rel="noopener"
							variant="outline"
							size="sm"
							class="shrink-0"
						>
							<MessageSquare class="size-3.5" />
							Reply on Reddit
						</Button>
					</div>
					<p class="mt-1 whitespace-pre-wrap text-sm">{latestReply.body}</p>
					<p class="mt-1 text-xs text-muted-foreground">
						{new Date(latestReply.createdAt).toLocaleString()}
					</p>
				</div>
			{/if}

			<!-- Event timeline -->
			{#if events.length > 0}
				<div class="pt-3 border-t border-border">
					<p class="text-[10px] font-semibold text-muted-foreground mb-3 uppercase tracking-wider">
						Timeline
					</p>
					<ol class="flex flex-col gap-3">
						{#each events as ev, i (ev.id)}
							{@const isLast = i === events.length - 1}
							<li class="flex items-start gap-3 min-w-0">
								<!-- Gutter: dot + vertical line with breathing room -->
								<div class="flex flex-col items-center w-3 flex-none pt-1">
									<span
										class="size-2 rounded-full bg-primary/70 ring-2 ring-background shrink-0"
									></span>
									{#if !isLast}
										<span class="w-px flex-1 bg-border mt-1 min-h-[20px]"></span>
									{/if}
								</div>
								<div class="flex-1 min-w-0 flex items-baseline gap-2 flex-wrap">
									<span class="text-xs font-medium">{EVENT_LABEL[ev.event] ?? ev.event}</span>
									<span class="text-[10px] text-muted-foreground">by {ev.actor}</span>
									<span class="text-[10px] text-muted-foreground ml-auto tabular-nums">
										{relativeTime(ev.createdAt)}
									</span>
								</div>
							</li>
						{/each}
					</ol>
				</div>
			{:else if loadingEvents}
				<div class="text-xs text-muted-foreground/60 italic">Loading timeline…</div>
			{/if}
		</div>
	</article>
{:else}
	<div class="h-full flex items-center justify-center text-muted-foreground text-sm">
		Select a draft
	</div>
{/if}

<Dialog.Root bind:open={sendDialogOpen}>
	<Dialog.Content class="max-w-2xl">
		<Dialog.Header>
			<Dialog.Title>Mark as sent</Dialog.Title>
			<Dialog.Description>
				Paste or edit what you actually sent on Reddit. Saved on the draft for future reference and
				logged to contact history.
			</Dialog.Description>
		</Dialog.Header>
		<Textarea bind:value={sentDraftText} rows={12} class="font-mono text-xs" />
		<div class="flex items-center justify-between text-xs text-muted-foreground">
			<span>
				{#if editedFromDraft}
					<Badge variant="secondary" class="text-[10px]">Edited from draft</Badge>
				{:else}
					<span>Identical to draft</span>
				{/if}
			</span>
			<span>{sentDraftText.length} chars</span>
		</div>
		<Dialog.Footer>
			<Button
				variant="outline"
				onclick={() => (sendDialogOpen = false)}
				disabled={sendingNow}
			>
				Cancel
			</Button>
			<Button onclick={confirmSent} loading={sendingNow}>Confirm sent</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
