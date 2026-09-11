<script lang="ts">
	import { Clipboard, Check, Send, ExternalLink, MessageSquare } from '@lucide/svelte';
	import { page } from '$app/stores';
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
	import { TONE_CLASS, TONE_BANNER_CLASS, badgeLabel } from '$lib/config/status-badges';
	import { replyUrl } from '$lib/utils/reply-url';
	import { getPresenter, isExtensionAutomated } from '$lib/platforms/presenter';
	import { isDraftKind, mapDraftKindToQuotaKind } from '@pitchbox/shared/quota-types';
	import type { UsageByKind, QuotaLimits } from '@pitchbox/shared/quota-types';
	import { interpretDraftPatchResponse, DraftVersionConflictError } from '$lib/utils/draft-patch-response';
	import { parseStyleFindings, highlightStyleFindingSpans, STYLE_FINDING_SPAN_CLASS } from '$lib/utils/style-findings';
	import {
		scoreBand,
		DEFAULT_QUALITY_RUBRIC,
		DETERMINISTIC_QUALITY_MODEL,
		type QualityRubric,
	} from '@pitchbox/shared/quality-bands';
	import { t, tn, type Locale } from '$lib/i18n/index.js';

	// scoreBand's band names are a shared-package contract (not the design
	// registry's Tone names) - mirrors DraftListItem's own translation table.
	const BAND_TONE: Record<'red' | 'amber' | 'green', 'rose' | 'amber' | 'emerald'> = {
		red: 'rose',
		amber: 'amber',
		green: 'emerald',
	};

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
		undeliverableReason?: string | null;
		qualityScore?: number | null;
		qualityReason?: string | null;
		qualityModel?: string | null;
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
		rubric = DEFAULT_QUALITY_RUBRIC,
		editRequestId = $bindable(null),
	}: {
		draft: Draft | null;
		usage?: UsageByKind;
		limits?: QuotaLimits | null;
		rubric?: QualityRubric;
		// Set by the parent (the inbox `e` shortcut) to the id of the draft that
		// should open its inline editor. Consumed and reset to null below.
		editRequestId?: number | null;
	} = $props();

	const locale = $derived($page.data.locale as Locale);

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
			toast.info(t(locale, 'inbox.toast-version-conflict'));
			throw new DraftVersionConflictError();
		}
		if (outcome.kind === 'error') throw new Error(outcome.message);
		await invalidateAll();
	}

	async function approve() {
		approving = true;
		try {
			await patch({ state: 'approved' });
			toast.success(t(locale, 'inbox.state.approved'), {
				description: t(locale, 'inbox.toast-approved-body'),
			});
		} catch (e) {
			if (e instanceof DraftVersionConflictError) return;
			toast.error(t(locale, 'inbox.toast-action-failed-title'), { description: (e as Error).message });
		} finally {
			approving = false;
		}
	}

	async function reject() {
		rejecting = true;
		try {
			await patch({ state: 'rejected' });
			toast.success(t(locale, 'inbox.state.rejected'));
		} catch (e) {
			if (e instanceof DraftVersionConflictError) return;
			toast.error(t(locale, 'inbox.toast-action-failed-title'), { description: (e as Error).message });
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
			toast.success(t(locale, 'draft-detail.toast-draft-updated'));
			editing = false;
			await invalidateAll();
		} catch (e) {
			toast.error(t(locale, 'draft-detail.error-save-edit-title'), { description: (e as Error).message });
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
			toast.success(t(locale, 'draft-detail.toast-regen-requested'));
			regenerateOpen = false;
			regenerateHint = '';
			await invalidateAll();
		} catch (e) {
			toast.error(t(locale, 'draft-detail.error-regen-title'), { description: (e as Error).message });
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
			toast.success(t(locale, 'draft-detail.toast-retry-reply'));
			await invalidateAll();
		} catch (e) {
			toast.error(t(locale, 'draft-detail.error-retry-title'), { description: (e as Error).message });
		}
	}

	async function cancelReplyDraft() {
		if (!draft) return;
		try {
			const res = await fetch(`/api/drafts/${draft.id}/reply-draft/cancel`, { method: 'POST' });
			if (!res.ok) throw new Error(await res.text());
			toast.success(t(locale, 'draft-detail.toast-cancel-drafting'));
			await invalidateAll();
		} catch (e) {
			toast.error(t(locale, 'draft-detail.error-cancel-title'), { description: (e as Error).message });
		}
	}

	async function cancelRegenerate() {
		if (!draft) return;
		try {
			const res = await fetch(`/api/drafts/${draft.id}/regenerate/cancel`, { method: 'POST' });
			if (!res.ok) throw new Error(await res.text());
			toast.success(t(locale, 'draft-detail.toast-regen-cancelled'));
			await invalidateAll();
		} catch (e) {
			toast.error(t(locale, 'draft-detail.error-cancel-title'), { description: (e as Error).message });
		}
	}

	async function undoRegenerate() {
		if (!draft) return;
		try {
			const res = await fetch(`/api/drafts/${draft.id}/regenerate/undo`, { method: 'POST' });
			if (!res.ok) throw new Error(await res.text());
			toast.success(t(locale, 'draft-detail.toast-reverted'));
			await invalidateAll();
		} catch (e) {
			toast.error(t(locale, 'draft-detail.error-undo-title'), { description: (e as Error).message });
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
			toast.success(t(locale, 'draft-detail.toast-marked-sent'));
			sendDialogOpen = false;
		} catch (e) {
			if (e instanceof DraftVersionConflictError) return;
			toast.error(t(locale, 'inbox.toast-action-failed-title'), { description: (e as Error).message });
		} finally {
			sendingNow = false;
		}
	}

	async function copyBody() {
		if (!draft) return;
		await navigator.clipboard.writeText(draft.body);
		copied = true;
		toast.success(t(locale, 'draft-detail.toast-copied'));
		setTimeout(() => (copied = false), 2000);
	}

	let hasSentVariant = $derived(
		draft?.sentContent != null && draft.sentContent !== draft.body
	);

	// Whether the extension can drive this platform's send flow end-to-end
	// (its content script arms the page and the draft flips to `sent`
	// automatically). reddit.com and linkedin.com have a matching content
	// script (see extension/manifest.config.ts) - every other platform needs
	// the human to open the link, send it themselves, and click "Mark as sent".
	const extensionAutomated = $derived(isExtensionAutomated(draft?.platformSlug ?? null));

	// A platform presenter's own eventLabel wins when it has one; failing
	// that, "created"/"edited" are draft-detail's own (part one never gave
	// them a badge-domain equivalent) and everything else - approved,
	// rejected, sent, replied, undeliverable - already has a translated
	// label in the draft-state badge registry, so reuse it rather than
	// keeping a second, parallel copy of the same five words.
	function eventLabel(event: string): string {
		const fromPresenter = getPresenter(draft?.platformSlug ?? null).eventLabel(locale, event);
		if (fromPresenter) return fromPresenter;
		if (event === 'created') return t(locale, 'draft-detail.event.created');
		if (event === 'edited') return t(locale, 'draft-detail.event.edited');
		return badgeLabel(locale, 'draft-state', event);
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
		return t(locale, `draft-detail.quota-label.${qk}`);
	}

	// D44: the style checker's structural findings that survived
	// `enforceHouseStyle`'s round trip, travelling on `metadata.styleFindings`.
	const styleFindings = $derived(draft ? parseStyleFindings(draft.metadata) : []);
	const highlightedBody = $derived(
		draft && styleFindings.length > 0
			? highlightStyleFindingSpans(draft.body, styleFindings)
			: (draft?.body ?? ''),
	);
	// LOR-229: the quality score's band and provenance - a measured
	// (deterministic) score and a judged one are different claims and never
	// render the same way.
	const qualityBand = $derived(draft ? scoreBand(draft.qualityScore, rubric) : 'none');
	const isJudged = $derived(
		!!draft && draft.qualityModel != null && draft.qualityModel !== DETERMINISTIC_QUALITY_MODEL,
	);
	// Mirrors DraftListItem's own qualityTitle: the translated lead-in plus
	// the raw reason (never translated - it's the checker's/judge's own
	// diagnostic text, not UI copy), or a bare period when there is none.
	const qualityDescription = $derived.by(() => {
		if (!draft) return '';
		const base = isJudged
			? t(locale, 'draft-detail.scored-by', { model: draft.qualityModel ?? '' })
			: t(locale, 'draft-detail.computed-from');
		return base + (draft.qualityReason ? `: ${draft.qualityReason}` : '.');
	});
</script>

{#if draft}
	{@const primary = getPresenter(draft.platformSlug).primaryLabel(locale, draft)}
	{@const metaSegments = [
		...(draft.fitScore != null
			? [{ key: 'fit', text: t(locale, 'draft-list-item.fit-score', { score: draft.fitScore }), href: undefined }]
			: []),
		{ key: 'run', text: t(locale, 'draft-detail.meta-run', { run: draft.runId }), href: `/inbox?run=${draft.runId}` },
		...(draft.createdAt
			? [{ key: 'created', text: relativeTime(draft.createdAt, locale), href: undefined }]
			: []),
		...(draft.sentAt
			? [{ key: 'sent', text: t(locale, 'draft-detail.meta-sent', { when: relativeTime(draft.sentAt, locale) }), href: undefined }]
			: []),
	]}
	{@const openLabel = extensionAutomated
		? draft.kind === 'dm'
			? t(locale, 'draft-detail.open-label.dm')
			: draft.kind === 'post'
				? t(locale, 'draft-detail.open-label.post')
				: t(locale, 'draft-detail.open-label.default')
		: t(locale, 'draft-detail.open-label.manual')}
	{@const openTooltip = extensionAutomated ? undefined : t(locale, 'draft-detail.open-tooltip')}

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
					{#each metaSegments as segment (segment.key)}
						<span class="text-muted-foreground/40">·</span>
						{#if segment.href}
							<a href={segment.href} class="hover:text-foreground transition-colors">{segment.text}</a>
						{:else}
							<span>{segment.text}</span>
						{/if}
					{/each}
				</div>
				{#if scheduledUntil}
					<div class="text-xs">
						<span
							class="inline-flex items-center gap-1 rounded-sm ring-1 ring-inset {TONE_CLASS.amber} px-1.5 py-0.5 text-[10px] font-medium"
							title={t(locale, 'draft-detail.scheduled-tooltip', { when: scheduledUntil.toLocaleString() })}
						>
							{t(locale, 'draft-list-item.scheduled-title', { when: scheduledUntil.toLocaleString() })}
						</span>
					</div>
				{/if}
				{#if draft.state === 'undeliverable' && draft.undeliverableReason}
					<div class="rounded-md border px-3 py-2 text-sm {TONE_BANNER_CLASS.slate}">
						<strong>{t(locale, 'draft-detail.undeliverable-label')}</strong>
						{draft.undeliverableReason}
					</div>
				{/if}
				{#if quotaKind && usage && limits}
					{@const u = usage[quotaKind]}
					{@const l = limits[quotaKind]}
					{@const overLimit = u.day > l.perDay || u.week > l.perWeek}
					{@const label = labelFor(quotaKind)}
					<div class="text-xs text-muted-foreground">
						{t(locale, 'draft-detail.account-quota-label')}
						<span class={overLimit ? 'font-medium text-foreground' : ''}
							>{t(locale, 'draft-detail.quota-today', { day: u.day, limit: l.perDay, label })}</span
						>
						· {t(locale, 'draft-detail.quota-week', { week: u.week, limit: l.perWeek })}
						{#if overLimit}<span aria-hidden="true" title={t(locale, 'draft-detail.over-limit-title')}>⚠</span>{/if}
					</div>
				{/if}
			</div>
			<div class="flex gap-2 flex-wrap justify-end shrink-0">
				<Button onclick={copyBody} variant="outline" size="sm" aria-label={t(locale, 'draft-detail.aria-copy')}>
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
							{t(locale, 'draft-detail.drafting-reply')}
						</span>
						<Button onclick={cancelReplyDraft} variant="outline" size="sm">{t(locale, 'inbox.cancel')}</Button>
					{:else if draftingFailed}
						<span class="text-destructive text-sm">{t(locale, 'draft-detail.reply-drafting-failed')}</span>
						<Button onclick={retryReplyDraft} variant="outline" size="sm">{t(locale, 'inbox.retry')}</Button>
					{:else if isRegenerating}
						<span class="text-muted-foreground inline-flex items-center gap-2 text-sm">
							<span
								class="border-muted-foreground/40 border-t-foreground h-3 w-3 animate-spin rounded-full border-2"
							></span>
							{t(locale, 'draft-detail.regenerating')}
						</span>
						<Button onclick={cancelRegenerate} variant="outline" size="sm">{t(locale, 'inbox.cancel')}</Button>
					{:else if !editing}
						<Button onclick={startEdit} variant="outline" size="sm">{t(locale, 'draft-detail.edit-button')}</Button>
						<Button onclick={() => (regenerateOpen = true)} variant="outline" size="sm">
							{t(locale, 'draft-detail.regenerate-button')}
						</Button>
						{#if (draft.regenerationCount ?? 0) > 0}
							<Button onclick={undoRegenerate} variant="ghost" size="sm">{t(locale, 'draft-detail.undo-button')}</Button>
						{/if}
					{/if}
					<Button
						onclick={reject}
						loading={rejecting}
						disabled={approving || rejecting}
						variant="outline"
						size="sm"
						class="border-destructive/60 text-destructive hover:bg-destructive/10 hover:text-destructive"
						aria-label={t(locale, 'draft-detail.aria-reject')}
					>
						{t(locale, 'inbox.reject-button')}
					</Button>
					<Button
						onclick={approve}
						loading={approving}
						disabled={approving || rejecting || isRegenerating || isDrafting || draftingFailed}
						variant="default"
						size="sm"
						aria-label={t(locale, 'draft-detail.aria-approve')}
					>
						{t(locale, 'draft-detail.approve-button')}
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
						{openLabel}
					</Button>
				{/if}
				{#if draft.state === 'approved'}
					<Button onclick={openSendDialog} variant="outline" size="sm">
						<Send class="size-3.5" />
						{t(locale, 'draft-detail.mark-as-sent')}
					</Button>
				{/if}
			</div>
		</header>

		<!-- Body -->
		<div class="flex-1 min-h-0 flex flex-col gap-4 py-4">
			{#if hasSentVariant}
				<Tabs.Root value="drafted" class="flex-1 flex flex-col min-h-0">
					<Tabs.List class="w-fit">
						<Tabs.Trigger value="drafted">{t(locale, 'draft-detail.tab-drafted')}</Tabs.Trigger>
						<Tabs.Trigger value="sent">{t(locale, 'draft-detail.tab-sent')}</Tabs.Trigger>
					</Tabs.List>
					<Tabs.Content value="drafted" class="flex-1 min-h-0 mt-2">
						<ScrollArea class="h-full rounded-lg border border-border/60 bg-muted/20 p-4">
						<Markdown source={highlightedBody} />
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
						aria-label={t(locale, 'draft-detail.aria-draft-body')}
					/>
					<div class="flex justify-end gap-2">
						<Button onclick={cancelEdit} variant="outline" size="sm" disabled={savingEdit}>
							{t(locale, 'inbox.cancel')}
						</Button>
						<Button onclick={saveEdit} loading={savingEdit} variant="default" size="sm">
							{t(locale, 'draft-detail.save-button')}
						</Button>
					</div>
				</div>
			{:else}
				<ScrollArea class="flex-1 rounded-lg border border-border/60 bg-muted/20 p-4">
					<Markdown source={highlightedBody} />
				</ScrollArea>
			{/if}

			<!-- D44: style-check findings that survived enforceHouseStyle's -->
			<!-- round trip. Always visible, never behind a disclosure. -->
			{#if styleFindings.length > 0}
				<div
					class="rounded-lg border border-destructive/30 bg-destructive/5 p-3 flex flex-col gap-2"
				>
					<p class="text-xs font-medium text-destructive">
						{tn(locale, 'draft-detail.style-check-flagged', styleFindings.length)}
					</p>
					<ul class="flex flex-col gap-1.5">
						{#each styleFindings as finding (finding.ruleId + finding.span)}
							<li class="text-xs text-foreground/90 leading-snug">
								{finding.message}
								<span class="{STYLE_FINDING_SPAN_CLASS} font-mono">
									{finding.span}
								</span>
							</li>
						{/each}
					</ul>
				</div>
			{/if}

			<!-- LOR-229: the quality score, always distinguishing measured
			(deterministic, no model call) from judged (a real, separate model
			call) - these are different claims about the same draft and must
			never look the same. -->
			{#if qualityBand !== 'none'}
				<div
					class="rounded-lg border p-3 flex items-start gap-2 text-xs {TONE_BANNER_CLASS[
						BAND_TONE[qualityBand as 'red' | 'amber' | 'green']
					]}"
				>
					<span
						class="inline-flex shrink-0 items-center rounded-sm px-1 py-0.5 text-[10px] font-semibold {TONE_CLASS[
							BAND_TONE[qualityBand as 'red' | 'amber' | 'green']
						]}"
					>
						{isJudged ? t(locale, 'draft-detail.judged-word') : t(locale, 'draft-detail.measured-word')}
						{draft.qualityScore}
					</span>
					<span class="text-foreground/80">
						{qualityDescription}
					</span>
				</div>
			{/if}

			{#if draft.reasoning}
				<div
					class="rounded-lg bg-muted/10 border-l-2 border-primary/40 px-3 py-2 text-xs text-muted-foreground"
				>
					<span class="font-medium text-foreground/70">{t(locale, 'draft-detail.why-it-fits')}</span>
					{draft.reasoning}
				</div>
			{/if}

			{#if latestReply}
				<div class="rounded-lg border-l-2 border-violet-400/60 bg-muted/40 p-3">
					<div class="flex items-start justify-between gap-3">
						<p class="text-[10px] uppercase tracking-wide text-muted-foreground">
							{t(locale, 'draft-detail.reply-from', { author: latestReply.author })}
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
							{getPresenter(draft.platformSlug).replyActionLabel(locale)}
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
						{t(locale, 'draft-detail.timeline-label')}
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
									<span class="text-[10px] text-muted-foreground">{t(locale, 'draft-detail.by-actor', { actor: ev.actor })}</span>
									<span class="text-[10px] text-muted-foreground ml-auto tabular-nums">
										{relativeTime(ev.createdAt, locale)}
									</span>
								</div>
							</li>
						{/each}
					</ol>
				</div>
			{:else if loadingEvents}
				<div class="text-xs text-muted-foreground/60 italic">{t(locale, 'draft-detail.loading-timeline')}</div>
			{/if}
		</div>
	</article>
{:else}
	<div class="h-full flex items-center justify-center text-muted-foreground text-sm">
		{t(locale, 'draft-detail.select-a-draft')}
	</div>
{/if}

<Dialog.Root bind:open={sendDialogOpen}>
	<Dialog.Content class="max-w-2xl">
		<Dialog.Header>
			<Dialog.Title>{t(locale, 'draft-detail.dialog.mark-sent-title')}</Dialog.Title>
			<Dialog.Description>
				{draft?.targetUser
					? t(locale, 'draft-detail.dialog.mark-sent-desc-with-recipient')
					: t(locale, 'draft-detail.dialog.mark-sent-desc-no-recipient')}
			</Dialog.Description>
		</Dialog.Header>
		{#if overQuota && quotaKind && usage && limits}
			<div class="rounded-md border px-3 py-2 text-sm {TONE_BANNER_CLASS.rose}">
				<strong>{t(locale, 'draft-detail.quota-reached-title')}</strong>
				{t(locale, 'draft-detail.quota-reached-sent', {
					day: usage[quotaKind].day,
					dayLimit: limits[quotaKind].perDay,
					label: labelFor(quotaKind),
				})}
				{#if overWeek}{t(locale, 'draft-detail.quota-reached-and-week', {
						week: usage[quotaKind].week,
						weekLimit: limits[quotaKind].perWeek,
					})}{/if}
				{t(locale, 'draft-detail.quota-reached-warning')}
			</div>
		{/if}
		<Textarea bind:value={sentDraftText} rows={12} class="font-mono text-xs" />
		<div class="flex items-center justify-between text-xs text-muted-foreground">
			<span>
				{#if editedFromDraft}
					<Badge variant="secondary" class="text-[10px]">{t(locale, 'draft-detail.edited-from-draft')}</Badge>
				{:else}
					<span>{t(locale, 'draft-detail.identical-to-draft')}</span>
				{/if}
			</span>
			<span>{t(locale, 'draft-detail.chars-count', { n: sentDraftText.length })}</span>
		</div>
		<Dialog.Footer>
			<Button
				variant="outline"
				onclick={() => (sendDialogOpen = false)}
				disabled={sendingNow}
			>
				{t(locale, 'inbox.cancel')}
			</Button>
			<Button onclick={confirmSent} loading={sendingNow}>{t(locale, 'draft-detail.confirm-sent-button')}</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

<!-- Regenerate-with-hint dialog -->
<Dialog.Root bind:open={regenerateOpen}>
	<Dialog.Content class="max-w-lg">
		<Dialog.Header>
			<Dialog.Title>{t(locale, 'draft-detail.dialog.regenerate-title')}</Dialog.Title>
			<Dialog.Description>
				{t(locale, 'draft-detail.dialog.regenerate-desc')}
			</Dialog.Description>
		</Dialog.Header>
		<Textarea
			bind:value={regenerateHint}
			rows={5}
			placeholder={t(locale, 'draft-detail.regenerate-hint-placeholder')}
		/>
		<Dialog.Footer>
			<Button
				variant="outline"
				onclick={() => (regenerateOpen = false)}
				disabled={regenerating}
			>
				{t(locale, 'inbox.cancel')}
			</Button>
			<Button onclick={regenerate} loading={regenerating}>{t(locale, 'draft-detail.regenerate-button')}</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
