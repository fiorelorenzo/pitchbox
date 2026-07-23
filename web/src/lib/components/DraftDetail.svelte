<script lang="ts">
	import { Clipboard, Check, Send, ExternalLink, MessageSquare } from '@lucide/svelte';
	import { browser } from '$app/environment';
	import { invalidateAll } from '$app/navigation';
	import { composeHref } from '$lib/utils/compose-url';
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
	import { replyUrl } from '$lib/utils/reply-url';
	import { getPresenter, isExtensionAutomated } from '$lib/platforms/presenter';
	import { isDraftKind, mapDraftKindToQuotaKind } from '@pitchbox/shared/quota-types';
	import type { UsageByKind, QuotaLimits } from '@pitchbox/shared/quota-types';
	import { interpretDraftPatchResponse, DraftVersionConflictError } from '$lib/utils/draft-patch-response';

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
		title?: string | null;
		targetUser: string | null;
		platformSlug: string | null;
		metadata: Record<string, unknown> | null;
		fitScore: number | null;
		state: string;
		body: string;
		composeUrl: string | null;
		reasoning: string | null;
		createdAt: string | Date | null;
		sentAt: string | Date | null;
		sentContent: string | null;
		regeneratingRunId?: number | null;
		regenerationCount?: number;
		draftingRunId?: number | null;
		draftingRunStatus?: string | null;
		scheduledSendAfter?: string | Date | null;
		version: number;
	};

	let {
		draft,
		usage,
		limits,
		editRequestId = $bindable(null),
	}: {
		draft: Draft | null;
		usage?: UsageByKind;
		limits?: QuotaLimits | null;
		// Set by the parent (the inbox `e` shortcut) to the id of the draft that
		// should open its inline editor. Consumed and reset to null below.
		editRequestId?: number | null;
	} = $props();

	type LatestReply = {
		body: string;
		author: string;
		createdAt: string | Date;
		chatRoomId?: string | null;
		platformContextUrl?: string | null;
		draftKind?: string | null;
	} | null;

	let approving = $state(false);
	let rejecting = $state(false);
	let copied = $state(false);
	// Inline body-edit state (issue #23). Editable while the draft is in
	// `pending_review` or `proposed`.
	let editing = $state(false);
	let editText = $state('');
	let savingEdit = $state(false);
	// Regenerate-with-hint state (issue #22).
	let regenerating = $state(false);
	let regenerateOpen = $state(false);
	let regenerateHint = $state('');
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
		// Send back the version last observed for this draft (issue #106/GRD-3)
		// so the server's optimistic-locking check fires when another tab (or
		// the extension) moved the row on in the meantime.
		const res = await fetch(`/inbox/${draft!.id}`, {
			method: 'PATCH',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ ...body, version: draft!.version }),
		});
		const outcome = await interpretDraftPatchResponse(res);
		if (outcome.kind === 'version_conflict') {
			await invalidateAll();
			toast.info('This draft changed elsewhere, reloaded.');
			throw new DraftVersionConflictError();
		}
		if (outcome.kind === 'error') throw new Error(outcome.message);
		await invalidateAll();
	}

	async function approve() {
		approving = true;
		try {
			await patch({ state: 'approved' });
			toast.success('Approved', { description: 'Open compose to send it.' });
		} catch (e) {
			if (e instanceof DraftVersionConflictError) return;
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
			if (e instanceof DraftVersionConflictError) return;
			toast.error('Action failed', { description: (e as Error).message });
		} finally {
			rejecting = false;
		}
	}

	function startEdit() {
		if (!draft) return;
		editText = draft.body;
		editing = true;
	}

	function cancelEdit() {
		editing = false;
		editText = '';
	}

	// Consume an editRequestId from the parent (the inbox `e` shortcut): open
	// the inline editor for the matching draft, then clear the request so it
	// doesn't refire on the next unrelated update.
	$effect(() => {
		if (draft && editRequestId === draft.id && !editing) {
			startEdit();
			editRequestId = null;
		}
	});

	async function saveEdit() {
		if (!draft) return;
		savingEdit = true;
		try {
			const res = await fetch(`/api/drafts/${draft.id}`, {
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ body: editText }),
			});
			if (!res.ok) {
				const msg = await res.text();
				throw new Error(msg || `HTTP ${res.status}`);
			}
			toast.success('Draft updated');
			editing = false;
			await invalidateAll();
		} catch (e) {
			toast.error('Could not save edit', { description: (e as Error).message });
		} finally {
			savingEdit = false;
		}
	}

	async function regenerate() {
		if (!draft) return;
		regenerating = true;
		try {
			const res = await fetch(`/api/drafts/${draft.id}/regenerate`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ hint: regenerateHint || undefined }),
			});
			if (!res.ok) {
				const msg = await res.text();
				throw new Error(msg || `HTTP ${res.status}`);
			}
			toast.success('Regeneration requested');
			regenerateOpen = false;
			regenerateHint = '';
			await invalidateAll();
		} catch (e) {
			toast.error('Could not regenerate', { description: (e as Error).message });
		} finally {
			regenerating = false;
		}
	}

	const isRegenerating = $derived(!!draft && draft.regeneratingRunId != null);
	const isDrafting = $derived(
		!!draft && draft.draftingRunId != null && draft.draftingRunStatus === 'running',
	);
	const draftingFailed = $derived(
		!!draft &&
			draft.draftingRunId != null &&
			draft.draftingRunStatus != null &&
			draft.draftingRunStatus !== 'running',
	);
	// A draft with a future scheduled_send_after is held back from "ready to
	// send" server-side (see evaluateDraftSend) - surface that here so the
	// reviewer isn't surprised by a 409 on send.
	const scheduledUntil = $derived.by(() => {
		if (!draft?.scheduledSendAfter) return null;
		const when = new Date(draft.scheduledSendAfter);
		return when.getTime() > Date.now() ? when : null;
	});

	async function retryReplyDraft() {
		if (!draft) return;
		try {
			const res = await fetch(`/api/drafts/${draft.id}/reply-draft/retry`, { method: 'POST' });
			if (!res.ok) throw new Error(await res.text());
			toast.success('Drafting the reply again');
			await invalidateAll();
		} catch (e) {
			toast.error('Could not retry', { description: (e as Error).message });
		}
	}

	async function cancelReplyDraft() {
		if (!draft) return;
		try {
			const res = await fetch(`/api/drafts/${draft.id}/reply-draft/cancel`, { method: 'POST' });
			if (!res.ok) throw new Error(await res.text());
			toast.success('Drafting cancelled');
			await invalidateAll();
		} catch (e) {
			toast.error('Could not cancel', { description: (e as Error).message });
		}
	}

	async function cancelRegenerate() {
		if (!draft) return;
		try {
			const res = await fetch(`/api/drafts/${draft.id}/regenerate/cancel`, { method: 'POST' });
			if (!res.ok) throw new Error(await res.text());
			toast.success('Regeneration cancelled');
			await invalidateAll();
		} catch (e) {
			toast.error('Could not cancel', { description: (e as Error).message });
		}
	}

	async function undoRegenerate() {
		if (!draft) return;
		try {
			const res = await fetch(`/api/drafts/${draft.id}/regenerate/undo`, { method: 'POST' });
			if (!res.ok) throw new Error(await res.text());
			toast.success('Reverted to the previous version');
			await invalidateAll();
		} catch (e) {
			toast.error('Could not undo', { description: (e as Error).message });
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
			if (e instanceof DraftVersionConflictError) return;
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

	// Whether the extension can drive this platform's send flow end-to-end
	// (its content script arms the page and the draft flips to `sent`
	// automatically). Only reddit.com has a matching content script (see
	// extension/manifest.config.ts) - every other platform needs the human to
	// open the link, send it themselves, and click "Mark as sent".
	const extensionAutomated = $derived(isExtensionAutomated(draft?.platformSlug ?? null));

	const GENERIC_EVENT_LABEL: Record<string, string> = {
		created: 'Created',
		approved: 'Approved',
		rejected: 'Rejected',
		sent: 'Sent',
		edited: 'Edited',
		replied: 'Replied',
	};

	function eventLabel(event: string): string {
		const fromPresenter = getPresenter(draft?.platformSlug ?? null).eventLabel(event);
		return fromPresenter ?? GENERIC_EVENT_LABEL[event] ?? event;
	}

	let editedFromDraft = $derived(draft != null && sentDraftText !== draft.body);

	const quotaKind = $derived(
		draft && isDraftKind(draft.kind) ? mapDraftKindToQuotaKind(draft.kind) : null,
	);

	const overDay = $derived(
		quotaKind && usage && limits
			? usage[quotaKind].day + 1 > limits[quotaKind].perDay
			: false,
	);
	const overWeek = $derived(
		quotaKind && usage && limits
			? usage[quotaKind].week + 1 > limits[quotaKind].perWeek
			: false,
	);
	const overQuota = $derived(overDay || overWeek);

	function labelFor(qk: 'dm' | 'comment' | 'post'): string {
		return { dm: 'DMs', comment: 'comments', post: 'posts' }[qk];
	}
</script>

{#if draft}
	{@const primary = getPresenter(draft.platformSlug).primaryLabel(draft)}
	{@const openLabel = extensionAutomated
		? draft.kind === 'dm'
			? 'Open compose ↗'
			: draft.kind === 'post'
				? 'Open submit ↗'
				: 'Open post ↗'
		: 'Open to send (manual) ↗'}
	{@const openTooltip = extensionAutomated
		? undefined
		: 'Pitchbox does not automate sending on this platform - open the link, send it yourself, then click "Mark as sent".'}

	<article class="h-full flex flex-col min-h-0">
		<!-- Header: borderless, generous spacing -->
		<header class="flex flex-wrap items-start justify-between gap-3 pb-4 border-b border-border">
			<div class="flex flex-col gap-1.5 min-w-0">
				<h2 class="text-lg font-semibold truncate">{primary}</h2>
				{#if draft.kind === 'post' && draft.title}
					<p class="text-base font-medium text-foreground/90 truncate" title={draft.title}>
						{draft.title}
					</p>
				{/if}
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
				{#if scheduledUntil}
					<div class="text-xs">
						<span
							class="inline-flex items-center gap-1 rounded-sm bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200 px-1.5 py-0.5 text-[10px] font-medium"
							title="This draft will not be sendable until {scheduledUntil.toLocaleString()}"
						>
							Scheduled until {scheduledUntil.toLocaleString()}
						</span>
					</div>
				{/if}
				{#if quotaKind && usage && limits}
					{@const u = usage[quotaKind]}
					{@const l = limits[quotaKind]}
					{@const overLimit = u.day > l.perDay || u.week > l.perWeek}
					{@const label = { dm: 'DMs', comment: 'comments', post: 'posts' }[quotaKind]}
					<div class="text-xs text-muted-foreground">
						Account quota:
						<span class={overLimit ? 'font-medium text-foreground' : ''}
							>{u.day}/{l.perDay} {label} today</span
						>
						· {u.week}/{l.perWeek} this week
						{#if overLimit}<span aria-hidden="true" title="Over limit">⚠</span>{/if}
					</div>
				{/if}
			</div>
			<div class="flex gap-2 flex-wrap justify-end shrink-0">
				<Button onclick={copyBody} variant="outline" size="sm" aria-label="Copy body to clipboard">
					{#if copied}
						<Check class="size-3.5" />
					{:else}
						<Clipboard class="size-3.5" />
					{/if}
				</Button>
				{#if draft.state === 'pending_review' || draft.state === 'proposed'}
					{#if isDrafting}
						<span class="text-muted-foreground inline-flex items-center gap-2 text-sm">
							<span
								class="border-muted-foreground/40 border-t-foreground h-3 w-3 animate-spin rounded-full border-2"
							></span>
							Drafting reply…
						</span>
						<Button onclick={cancelReplyDraft} variant="outline" size="sm">Cancel</Button>
					{:else if draftingFailed}
						<span class="text-destructive text-sm">Reply drafting failed</span>
						<Button onclick={retryReplyDraft} variant="outline" size="sm">Retry</Button>
					{:else if isRegenerating}
						<span class="text-muted-foreground inline-flex items-center gap-2 text-sm">
							<span
								class="border-muted-foreground/40 border-t-foreground h-3 w-3 animate-spin rounded-full border-2"
							></span>
							Regenerating…
						</span>
						<Button onclick={cancelRegenerate} variant="outline" size="sm">Cancel</Button>
					{:else if !editing}
						<Button onclick={startEdit} variant="outline" size="sm">Edit</Button>
						<Button onclick={() => (regenerateOpen = true)} variant="outline" size="sm">
							Regenerate
						</Button>
						{#if (draft.regenerationCount ?? 0) > 0}
							<Button onclick={undoRegenerate} variant="ghost" size="sm">Undo</Button>
						{/if}
					{/if}
					<Button
						onclick={approve}
						loading={approving}
						disabled={isRegenerating || isDrafting || draftingFailed}
						variant="default"
						size="sm"
					>
						Approve
					</Button>
					<Button onclick={reject} loading={rejecting} variant="destructive" size="sm">
						Reject
					</Button>
				{/if}
				{#if draft.state === 'approved' && draft.composeUrl}
					<Button
						href={composeHref(
							draft.composeUrl,
							draft.id,
							browser ? window.location.origin : undefined,
						)}
						target="_blank"
						rel="noopener"
						title={openTooltip}
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
			{:else if editing}
				<div class="flex-1 rounded-lg border border-border/60 bg-muted/20 p-3 flex flex-col gap-2">
					<Textarea
						bind:value={editText}
						class="flex-1 min-h-[200px] resize-none font-mono text-sm"
						aria-label="Draft body"
					/>
					<div class="flex justify-end gap-2">
						<Button onclick={cancelEdit} variant="outline" size="sm" disabled={savingEdit}>
							Cancel
						</Button>
						<Button onclick={saveEdit} loading={savingEdit} variant="default" size="sm">
							Save
						</Button>
					</div>
				</div>
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
							href={replyUrl({
								draftKind: latestReply.draftKind ?? draft?.kind ?? null,
								targetUser: latestReply.author,
								chatRoomId: latestReply.chatRoomId ?? null,
								platformContextUrl: latestReply.platformContextUrl ?? null,
							})}
							target="_blank"
							rel="noopener"
							variant="outline"
							size="sm"
							class="shrink-0"
						>
							<MessageSquare class="size-3.5" />
							{getPresenter(draft.platformSlug).replyActionLabel()}
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
									<span class="text-xs font-medium">{eventLabel(ev.event)}</span>
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
				Paste or edit what you actually sent. Saved on the draft for future reference and logged
				to contact history.
			</Dialog.Description>
		</Dialog.Header>
		{#if overQuota && quotaKind && usage && limits}
			<div class="rounded-md bg-red-50 ring-1 ring-red-200 px-3 py-2 text-sm text-red-800">
				<strong>Quota reached.</strong>
				You've already sent {usage[quotaKind].day}/{limits[quotaKind].perDay} {labelFor(quotaKind)} today
				{#if overWeek}and {usage[quotaKind].week}/{limits[quotaKind].perWeek} this week{/if}
				from this account. The platform may rate-limit or suspend the account if you continue.
				Proceed only if necessary.
			</div>
		{/if}
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

<!-- Regenerate-with-hint dialog -->
<Dialog.Root bind:open={regenerateOpen}>
	<Dialog.Content class="max-w-lg">
		<Dialog.Header>
			<Dialog.Title>Regenerate draft</Dialog.Title>
			<Dialog.Description>
				Optional hint for the agent: what should it change in the next pass?
			</Dialog.Description>
		</Dialog.Header>
		<Textarea
			bind:value={regenerateHint}
			rows={5}
			placeholder="e.g. Make it shorter and reference the latest comment."
		/>
		<Dialog.Footer>
			<Button
				variant="outline"
				onclick={() => (regenerateOpen = false)}
				disabled={regenerating}
			>
				Cancel
			</Button>
			<Button onclick={regenerate} loading={regenerating}>Regenerate</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
