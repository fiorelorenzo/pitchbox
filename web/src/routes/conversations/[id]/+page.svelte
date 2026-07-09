<script lang="ts">
  import PageHeader from '$lib/components/PageHeader.svelte';
  import Seo from '$lib/components/Seo.svelte';
  import StatusBadge from '$lib/components/StatusBadge.svelte';
  import * as Card from '$lib/components/ui/card';
  import { Textarea } from '$lib/components/ui/textarea';
  import { Button } from '$lib/components/ui/button';
  import { getPresenter } from '$lib/platforms/presenter';
  import { relativeTime } from '$lib/utils/time';
  import { cn } from '$lib/utils';

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
    } | null;
  };

  let { data }: { data: Data } = $props();

  const cp = $derived(getPresenter(data.thread.platform));

  const isDrafting = $derived(
    data.replyDraft?.draftingRunId != null && data.replyDraft?.draftingRunStatus === 'running',
  );
  const draftingFailed = $derived(
    data.replyDraft?.draftingRunId != null &&
      data.replyDraft?.draftingRunStatus != null &&
      data.replyDraft?.draftingRunStatus !== 'running',
  );

  async function retryReplyDraft() {
    if (!data.replyDraft) return;
    await fetch(`/api/drafts/${data.replyDraft.id}/reply-draft/retry`, { method: 'POST' });
    location.reload();
  }
</script>

<Seo
  title={`Conversation with ${data.thread.targetUser}`}
  description="Threaded view of an outreach conversation."
/>

<PageHeader
  title={cp.userLabel(data.thread.targetUser)}
  description={`Conversation via ${cp.userLabel(data.thread.accountHandle)} on ${data.thread.platform}`}
>
  {#snippet actions()}
    <a
      href="/conversations"
      class="inline-flex items-center rounded-md border border-border/60 px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground"
    >
      Back to conversations
    </a>
  {/snippet}
</PageHeader>

<div class="mb-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
  <StatusBadge
    domain="draft-state"
    value={data.contactHistory.repliedAt ? 'replied' : 'sent'}
  />
  <span>First contact {relativeTime(data.contactHistory.firstContactedAt)}</span>
  {#if data.contactHistory.repliedAt}
    <span>· Replied {relativeTime(data.contactHistory.repliedAt)}</span>
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
          <span>Draft #{draft.id}</span>
          {#if draft.sentAt}
            <span>· Sent {relativeTime(draft.sentAt)}</span>
          {/if}
        </div>
      </div>
    {/if}

    {#if data.messages.length === 0 && !data.parentDraft}
      <p class="py-8 text-center text-sm text-muted-foreground">
        No messages captured yet for this thread.
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
            {isUs ? 'you' : cp.userLabel(m.author)}
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
        <span class="text-xs font-medium text-emerald-700 dark:text-emerald-300"
          >Suggested reply (auto-drafted)</span
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
            onclick={async (e: MouseEvent) => {
              e.preventDefault();
              await fetch(`/inbox/${data.replyDraft!.id}`, {
                method: 'PATCH',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ state: 'rejected' }),
              });
              location.reload();
            }}>Reject</Button
          >
        </form>
        {#if isDrafting}
          <span class="text-xs text-muted-foreground">Drafting reply…</span>
        {:else if draftingFailed}
          <span class="text-xs text-destructive">Reply drafting failed</span>
          <Button size="sm" variant="outline" onclick={retryReplyDraft}>Retry</Button>
        {:else}
          <Button
            size="sm"
            onclick={async () => {
              await fetch(`/inbox/${data.replyDraft!.id}`, {
                method: 'PATCH',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ state: 'approved' }),
              });
              location.reload();
            }}>Approve</Button
          >
        {/if}
      </div>
    </Card.Content>
  </Card.Root>
{:else}
  <Card.Root size="sm" class="mt-4">
    <Card.Content class="flex flex-col gap-2 p-4">
      <Textarea
        placeholder="Write a reply…"
        rows={3}
        disabled
        class="resize-none bg-background"
      />
      <div class="flex items-center justify-between">
        <span class="text-[11px] text-muted-foreground">No auto-drafted reply yet</span>
        <Button size="sm" disabled>Send</Button>
      </div>
    </Card.Content>
  </Card.Root>
{/if}
