<script lang="ts">
  import { page } from '$app/stores';
  import { t, type Locale } from '$lib/i18n/index.js';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import Seo from '$lib/components/Seo.svelte';
  import StatusBadge from '$lib/components/StatusBadge.svelte';
  import * as Card from '$lib/components/ui/card';
  import { Textarea } from '$lib/components/ui/textarea';
  import { Button } from '$lib/components/ui/button';
  import { getPresenter } from '$lib/platforms/presenter';
  import { relativeTime } from '$lib/utils/time';
  import { cn } from '$lib/utils';
  import { toast } from 'svelte-sonner';
  import {
    interpretDraftPatchResponse,
    DraftVersionConflictError,
  } from '$lib/utils/draft-patch-response';
  import { TONE_TEXT_CLASS, TONE_BANNER_CLASS } from '$lib/config/status-badges';
  import PageContainer from '$lib/components/PageContainer.svelte';

  type Message = {
    id: number;
    author: string;
    isFromUs: boolean;
    body: string;
    createdAt: string | Date;
    source: string | null;
    kind: string | null;
  };

  type Data = {
    thread: {
      id: string;
      accountHandle: string;
      targetUser: string;
      platform: string;
    };
    messages: Message[];
    parentDraft: {
      id: number;
      kind: string;
      body: string;
      state: string;
      sentAt: string | Date | null;
    } | null;
    contactHistory: {
      firstContactedAt: string | Date;
      lastContactedAt: string | Date;
      repliedAt: string | Date | null;
      outcome: string;
      platformContextUrl: string | null;
      chatRoomId: string | null;
    };
    replyDraft: {
      id: number;
      kind: string;
      body: string;
      state: string;
      parentMessageId: number | null;
      draftingRunId: number | null;
      draftingRunStatus: string | null;
      version: number;
    } | null;
  };

  let { data }: { data: Data } = $props();

  const cp = $derived(getPresenter(data.thread.platform));
  const locale = $derived($page.data.locale as Locale);

  const isDrafting = $derived(
    data.replyDraft?.draftingRunId != null && data.replyDraft?.draftingRunStatus === 'running',
  );
  const draftingFailed = $derived(
    data.replyDraft?.draftingRunId != null &&
      data.replyDraft?.draftingRunStatus != null &&
      data.replyDraft?.draftingRunStatus !== 'running',
  );

  let retryingReply = $state(false);
  let rejectingReply = $state(false);
  let approvingReply = $state(false);
  let retryError = $state<string | null>(null);
  const replyActionBusy = $derived(retryingReply || rejectingReply || approvingReply);

  async function retryReplyDraft() {
    if (!data.replyDraft) return;
    retryingReply = true;
    retryError = null;
    try {
      const res = await fetch(`/api/drafts/${data.replyDraft.id}/reply-draft/retry`, { method: 'POST' });
      if (res.status === 409) {
        toast.info(t(locale, 'conversations.toast-retry-in-progress'));
        location.reload();
        return;
      }
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
        const message =
          res.status >= 500
            ? t(locale, 'conversations.error-retry-5xx')
            : (body.error ?? body.message ?? t(locale, 'conversations.error-retry'));
        if (res.status >= 500) {
          console.error('failed to retry reply draft', data.replyDraft.id, res.status, body);
        }
        retryError = message;
        toast.error(message);
        return;
      }
      location.reload();
    } catch {
      const message = t(locale, 'conversations.error-retry-offline');
      retryError = message;
      toast.error(message);
    } finally {
      retryingReply = false;
    }
  }

  async function patchReplyDraft(body: Record<string, unknown>) {
    // Send back the version last observed for this draft (issue #106/GRD-3)
    // so the server's optimistic-locking check fires when another tab (or
    // the extension) moved the row on in the meantime.
    const res = await fetch(`/inbox/${data.replyDraft!.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...body, version: data.replyDraft!.version }),
    });
    const outcome = await interpretDraftPatchResponse(res);
    if (outcome.kind === 'version_conflict') {
      toast.info(t(locale, 'inbox.toast-version-conflict'));
      location.reload();
      throw new DraftVersionConflictError();
    }
    if (outcome.kind === 'error') throw new Error(outcome.message);
    location.reload();
  }

  async function rejectReplyDraft() {
    if (!data.replyDraft) return;
    rejectingReply = true;
    try {
      await patchReplyDraft({ state: 'rejected' });
    } catch (e) {
      if (e instanceof DraftVersionConflictError) return;
      toast.error(t(locale, 'inbox.toast-action-failed-title'), { description: (e as Error).message });
    } finally {
      rejectingReply = false;
    }
  }

  async function approveReplyDraft() {
    if (!data.replyDraft) return;
    approvingReply = true;
    try {
      await patchReplyDraft({ state: 'approved' });
    } catch (e) {
      if (e instanceof DraftVersionConflictError) return;
      toast.error(t(locale, 'inbox.toast-action-failed-title'), { description: (e as Error).message });
    } finally {
      approvingReply = false;
    }
  }
</script>

<PageContainer size="default">
<Seo
  title={t(locale, 'conversations.seo-title', { user: data.thread.targetUser })}
  description={t(locale, 'conversations.seo-description')}
/>

<PageHeader
  title={cp.userLabel(data.thread.targetUser)}
  description={t(locale, 'conversations.header-description', { account: cp.userLabel(data.thread.accountHandle), platform: data.thread.platform })}
>
  {#snippet actions()}
    <a
      href="/people"
      class="inline-flex items-center rounded-md border border-border/60 px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground"
    >
      {t(locale, 'conversations.back-to-threads')}
    </a>
  {/snippet}
</PageHeader>

<div class="mb-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
  <StatusBadge
    domain="draft-state"
    value={data.contactHistory.repliedAt ? 'replied' : 'sent'}
  />
  <span>{t(locale, 'conversations.first-contact', { when: relativeTime(data.contactHistory.firstContactedAt) })}</span>
  {#if data.contactHistory.repliedAt}
    <span>· {t(locale, 'conversations.replied-at', { when: relativeTime(data.contactHistory.repliedAt) })}</span>
  {/if}
</div>

<Card.Root size="sm">
  <Card.Content class="flex flex-col gap-3 p-4">
    {#if data.parentDraft}
      {@const draft = data.parentDraft}
      <div class="flex flex-col items-end gap-1">
        <div
          class="max-w-[80%] rounded-2xl rounded-br-md bg-primary px-3.5 py-2 text-sm leading-relaxed text-primary-foreground shadow-sm"
        >
          <p class="whitespace-pre-wrap">{draft.body}</p>
        </div>
        <div class="flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <StatusBadge domain="draft-kind" value={draft.kind} />
          <span>{t(locale, 'conversations.draft-number', { id: draft.id })}</span>
          {#if draft.sentAt}
            <span>· {t(locale, 'conversations.sent-at', { when: relativeTime(draft.sentAt) })}</span>
          {/if}
        </div>
      </div>
    {/if}

    {#if data.messages.length === 0 && !data.parentDraft}
      <p class="py-8 text-center text-sm text-muted-foreground">
        {t(locale, 'conversations.no-messages')}
      </p>
    {/if}

    {#each data.messages as m (m.id)}
      {@const isUs = m.isFromUs}
      <div class={cn('flex flex-col gap-1', isUs ? 'items-end' : 'items-start')}>
        <div
          class={cn(
            'max-w-[80%] rounded-2xl px-3.5 py-2 text-sm leading-relaxed shadow-sm',
            isUs
              ? 'rounded-br-md bg-primary text-primary-foreground'
              : 'rounded-bl-md bg-muted text-foreground',
          )}
        >
          <p class="whitespace-pre-wrap">{m.body}</p>
        </div>
        <div class="flex items-center gap-1.5 text-[10px] text-muted-foreground">
          {#if m.kind}
            <StatusBadge domain="draft-kind" value={m.kind} />
          {/if}
          <span class="font-mono">
            {isUs ? t(locale, 'conversations.you-label') : cp.userLabel(m.author)}
          </span>
          <span>· {relativeTime(m.createdAt)}</span>
        </div>
      </div>
    {/each}
  </Card.Content>
</Card.Root>

{#if data.replyDraft}
  <Card.Root size="sm" class="mt-4 border-emerald-500/40">
    <Card.Content class="flex flex-col gap-2 p-4">
      <div class="flex items-center justify-between">
        <span class="text-xs font-medium {TONE_TEXT_CLASS.emerald}"
          >{t(locale, 'conversations.suggested-reply-label')}</span
        >
        <StatusBadge domain="draft-kind" value={data.replyDraft.kind} />
      </div>
      <Textarea
        value={data.replyDraft.body}
        rows={4}
        readonly
        class="resize-none bg-background"
      />
      <div class="flex items-center justify-end gap-2">
        <form method="POST" action="/inbox/{data.replyDraft.id}?_method=PATCH">
          <Button
            size="sm"
            variant="outline"
            loading={rejectingReply}
            disabled={replyActionBusy}
            class="border-destructive/60 text-destructive hover:bg-destructive/10 hover:text-destructive"
            aria-label={t(locale, 'conversations.aria-reject-reply')}
            onclick={async (e: MouseEvent) => {
              e.preventDefault();
              await rejectReplyDraft();
            }}>{t(locale, 'inbox.reject-button')}</Button
          >
        </form>
        {#if isDrafting}
          <span class="text-xs text-muted-foreground">{t(locale, 'draft-detail.drafting-reply')}</span>
        {:else if draftingFailed}
          <span class="text-xs text-destructive">{t(locale, 'draft-detail.reply-drafting-failed')}</span>
          <Button
            size="sm"
            variant="outline"
            loading={retryingReply}
            disabled={replyActionBusy}
            aria-label={t(locale, 'conversations.aria-retry-reply')}
            onclick={retryReplyDraft}>{t(locale, 'inbox.retry')}</Button
          >
        {:else}
          <Button
            size="sm"
            loading={approvingReply}
            disabled={replyActionBusy}
            aria-label={t(locale, 'conversations.aria-approve-reply')}
            onclick={approveReplyDraft}>{t(locale, 'draft-detail.approve-button')}</Button
          >
        {/if}
      </div>
      {#if retryError}
        <div role="alert" class="rounded-md border px-2 py-1.5 text-xs {TONE_BANNER_CLASS.rose}">
          {retryError}
        </div>
      {/if}
    </Card.Content>
  </Card.Root>
{:else}
  <Card.Root size="sm" class="mt-4">
    <Card.Content class="flex flex-col gap-2 p-4">
      <Textarea
        placeholder={t(locale, 'conversations.reply-placeholder')}
        rows={3}
        disabled
        class="resize-none bg-background"
      />
      <div class="flex items-center justify-between">
        <span class="text-[11px] text-muted-foreground">{t(locale, 'conversations.no-reply-draft-yet')}</span>
        <Button size="sm" disabled>{t(locale, 'conversations.send-button')}</Button>
      </div>
    </Card.Content>
  </Card.Root>
{/if}
</PageContainer>
