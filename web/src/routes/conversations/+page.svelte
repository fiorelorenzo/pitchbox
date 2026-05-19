<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/stores';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import ChatSyncStalledBanner from '$lib/components/ChatSyncStalledBanner.svelte';
  import Seo from '$lib/components/Seo.svelte';
  import StatusBadge from '$lib/components/StatusBadge.svelte';
  import * as Card from '$lib/components/ui/card';
  import { Input } from '$lib/components/ui/input';
  import { Button } from '$lib/components/ui/button';
  import { Search, MessageSquare } from 'lucide-svelte';
  import EmptyState from '$lib/components/EmptyState.svelte';
  import { relativeTime } from '$lib/utils/time';
  import { cn } from '$lib/utils';
  import { replyUrl } from '$lib/utils/reply-url';
  import { getPresenter } from '$lib/platforms/presenter';
  import { encodeThreadId } from './[id]/thread-id';

  type Convo = {
    contactId: number;
    accountHandle: string;
    targetUser: string;
    platformSlug: string;
    lastContactedAt: string;
    repliedAt: string | null;
    chatRoomId: string | null;
    draftMetadata: Record<string, unknown> | null;
    platformContextUrl: string | null;
    draftId: number | null;
    draftKind: string | null;
    draftState: string | null;
    draftBody: string | null;
    lastMessage: {
      body: string;
      author: string;
      createdAt: string;
      isFromUs: boolean;
    } | null;
  };

  let { data }: { data: { conversations: Convo[]; chatSyncUnauthorized?: boolean } } = $props();

  type Filter = 'all' | 'replied' | 'awaiting';
  let filter = $derived(($page.url.searchParams.get('filter') as Filter) ?? 'all');
  let search = $state($page.url.searchParams.get('q') ?? '');

  function setFilter(next: Filter) {
    const url = new URL($page.url);
    if (next === 'all') url.searchParams.delete('filter');
    else url.searchParams.set('filter', next);
    goto(url, { replaceState: true, noScroll: true, keepFocus: true });
  }

  function snippet(s: string, n = 180): string {
    return s.length <= n ? s : s.slice(0, n - 1) + '…';
  }

  function initials(handle: string): string {
    return handle.slice(0, 2).toUpperCase();
  }

  type KindFilter = 'all' | 'dm' | 'post_comment';
  let kindFilter = $derived(($page.url.searchParams.get('kind') as KindFilter) ?? 'all');
  function setKindFilter(next: KindFilter) {
    const url = new URL($page.url);
    if (next === 'all') url.searchParams.delete('kind');
    else url.searchParams.set('kind', next);
    goto(url, { replaceState: true, noScroll: true, keepFocus: true });
  }

  let counts = $derived({
    all: data.conversations.length,
    replied: data.conversations.filter((c) => c.repliedAt).length,
    awaiting: data.conversations.filter((c) => !c.repliedAt).length,
  });

  let filtered = $derived(
    data.conversations.filter((c) => {
      if (filter === 'replied' && !c.repliedAt) return false;
      if (filter === 'awaiting' && c.repliedAt) return false;
      if (kindFilter !== 'all' && c.draftKind !== kindFilter) return false;
      if (search.trim()) {
        const q = search.trim().toLowerCase();
        if (
          !c.targetUser.toLowerCase().includes(q) &&
          !c.accountHandle.toLowerCase().includes(q) &&
          !(c.lastMessage?.body.toLowerCase().includes(q) ?? false)
        ) {
          return false;
        }
      }
      return true;
    }),
  );

  type Tone = 'default' | 'replied' | 'awaiting';
  function avatarTone(c: Convo): Tone {
    if (c.repliedAt) return 'replied';
    return 'awaiting';
  }
  const AVATAR_CLASS: Record<Tone, string> = {
    default: 'bg-muted text-foreground/70 ring-border/50',
    replied: 'bg-violet-500/15 text-violet-700 dark:text-violet-300 ring-violet-500/25',
    awaiting: 'bg-muted text-muted-foreground ring-border/50',
  };
</script>

<Seo
  title="Conversations"
  description="Every outreach and its reply - DMs and comment threads in one place."
/>

<PageHeader
  title="Conversations"
  description="Every outreach you've sent plus replies captured by the browser extension."
/>

<ChatSyncStalledBanner show={!!data.chatSyncUnauthorized} />

<div class="mb-4 flex flex-wrap items-center gap-2">
  {#each [{ key: 'all', label: 'All' }, { key: 'awaiting', label: 'Awaiting reply' }, { key: 'replied', label: 'Replied' }] as f (f.key)}
    {@const active = filter === f.key}
    <button
      type="button"
      onclick={() => setFilter(f.key as Filter)}
      class={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs transition-colors',
        active
          ? 'border-primary/40 bg-primary/10 text-foreground'
          : 'border-border/60 text-muted-foreground hover:bg-accent/40 hover:text-foreground',
      )}
    >
      {f.label}
      <span
        class={cn(
          'rounded-full px-1.5 text-[10px] tabular-nums',
          active ? 'bg-primary/15 text-foreground/80' : 'bg-muted text-muted-foreground/80',
        )}
      >
        {counts[f.key as Filter]}
      </span>
    </button>
  {/each}

  <div class="relative w-full sm:ml-auto sm:w-64">
    <Search
      class="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
    />
    <Input
      bind:value={search}
      placeholder="Search handle or message"
      class="h-8 pl-8 text-xs"
    />
  </div>

  <Button
    variant="outline"
    size="sm"
    onclick={() => {
      // Mirror the current conversations filters into the export URL.
      const qs = new URLSearchParams($page.url.searchParams);
      qs.set('format', 'csv');
      window.location.href = `/api/export/conversations?${qs.toString()}`;
    }}
  >
    Export CSV
  </Button>
</div>

<div class="mb-4 flex flex-wrap items-center gap-2">
  {#each [{ key: 'all', label: 'All kinds' }, { key: 'dm', label: 'DMs' }, { key: 'post_comment', label: 'Comments' }] as k (k.key)}
    {@const active = kindFilter === k.key}
    <button
      type="button"
      onclick={() => setKindFilter(k.key as KindFilter)}
      class={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs transition-colors',
        active
          ? 'border-primary/40 bg-primary/10 text-foreground'
          : 'border-border/60 text-muted-foreground hover:bg-accent/40 hover:text-foreground',
      )}
    >
      {k.label}
    </button>
  {/each}
</div>

<Card.Root size="sm">
  <Card.Content class="divide-y divide-border p-0">
    {#if data.conversations.length === 0}
      <EmptyState
        icon={MessageSquare}
        title="No conversations yet"
        description="Once you send a DM or a comment-reply and the browser extension picks up an inbound message, the thread will land here. Pair the extension from the side panel to start syncing."
      />
    {:else if filtered.length === 0}
      <EmptyState
        icon={Search}
        title="No matches"
        description="No conversations match the current filters. Try clearing the search or switching the kind filter."
        size="sm"
      />
    {:else}
      {#each filtered as c (c.contactId)}
        {@const threadId = encodeThreadId({
          accountHandle: c.accountHandle,
          targetUser: c.targetUser,
          platform: c.platformSlug,
        })}
        {@const href = `/conversations/${threadId}`}
        {@const cp = getPresenter(c.platformSlug)}
        {@const subredditCtx =
          c.draftKind === 'post_comment' && typeof c.draftMetadata?.subreddit === 'string'
            ? (c.draftMetadata.subreddit as string)
            : null}
        <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
        <div
          role="button"
          tabindex={0}
          aria-label={`Open conversation with ${cp.userLabel(c.targetUser)}`}
          onclick={() => goto(href)}
          onkeydown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              goto(href);
            }
          }}
          class={cn(
            'group flex items-start gap-3 px-4 py-3 transition-colors cursor-pointer hover:bg-accent/40',
            c.repliedAt && 'border-l-2 border-l-violet-400/50',
          )}
        >
          <div
            class={cn(
              'mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold ring-1 ring-inset',
              AVATAR_CLASS[avatarTone(c)],
            )}
            aria-hidden="true"
          >
            {initials(c.targetUser)}
          </div>
          <div class="min-w-0 flex-1">
            <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span class="font-mono text-sm font-medium">{cp.userLabel(c.targetUser)}</span>
              {#if c.draftKind}
                <StatusBadge domain="draft-kind" value={c.draftKind} />
              {/if}
              {#if c.repliedAt}
                <StatusBadge domain="draft-state" value="replied" />
              {/if}
              <span class="text-xs text-muted-foreground">
                via {cp.userLabel(c.accountHandle)}
                {#if subredditCtx}
                  · {cp.primaryLabel({ kind: 'post_comment', targetUser: null, metadata: { subreddit: subredditCtx } })}
                {:else}
                  · {c.platformSlug}
                {/if}
              </span>
              <span
                class="ml-auto inline-flex items-center gap-2 text-[11px] text-muted-foreground/70"
              >
                {#if c.draftId != null}
                  <span class="group-hover:text-muted-foreground">Draft #{c.draftId}</span>
                {/if}
                <a
                  href={replyUrl({
                    draftKind: c.draftKind,
                    targetUser: c.targetUser,
                    chatRoomId: c.chatRoomId,
                    platformContextUrl: c.platformContextUrl,
                  })}
                  target="_blank"
                  rel="noopener"
                  onclick={(e) => e.stopPropagation()}
                  class="inline-flex items-center gap-1 rounded-md border border-border/60 px-2 py-0.5 text-foreground/80 transition-colors hover:border-primary/40 hover:bg-primary/10 hover:text-foreground"
                  title={c.draftKind === 'post_comment' && subredditCtx
                    ? `Open the thread on ${cp.primaryLabel({ kind: 'post_comment', targetUser: null, metadata: { subreddit: subredditCtx } })}`
                    : c.chatRoomId
                      ? `Open chat with ${cp.userLabel(c.targetUser)}`
                      : `Open ${cp.userLabel(c.targetUser)}'s profile`}
                >
                  <MessageSquare class="size-3" />
                  Reply
                </a>
              </span>
            </div>
            {#if c.lastMessage}
              <p class="mt-1 text-sm leading-snug">
                <span class="text-muted-foreground"
                  >{c.lastMessage.isFromUs ? 'you' : cp.userLabel(c.lastMessage.author)}:</span
                >
                {snippet(c.lastMessage.body)}
              </p>
              <p class="mt-1 text-[11px] text-muted-foreground">
                {relativeTime(c.lastMessage.createdAt)}
              </p>
            {:else}
              <p class="mt-1 text-xs text-muted-foreground">
                Sent {relativeTime(c.lastContactedAt)} - no reply yet.
              </p>
            {/if}
          </div>
        </div>
      {/each}
    {/if}
  </Card.Content>
</Card.Root>
