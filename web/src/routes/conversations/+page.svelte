<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/stores';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import Seo from '$lib/components/Seo.svelte';
  import StatusBadge from '$lib/components/StatusBadge.svelte';
  import * as Card from '$lib/components/ui/card';
  import { Input } from '$lib/components/ui/input';
  import { Search, Inbox, MessageSquare } from 'lucide-svelte';
  import { relativeTime } from '$lib/utils/time';
  import { cn } from '$lib/utils';

  type Convo = {
    contactId: number;
    accountHandle: string;
    targetUser: string;
    platformSlug: string;
    lastContactedAt: string;
    repliedAt: string | null;
    chatRoomId: string | null;
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

  let { data }: { data: { conversations: Convo[] } } = $props();

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

  function chatUrl(handle: string, roomId: string | null): string {
    return roomId
      ? `https://www.reddit.com/chat/room/${encodeURIComponent(roomId)}`
      : `https://www.reddit.com/user/${handle}/`;
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
    replied: 'bg-violet-500/15 text-violet-300 ring-violet-500/25',
    awaiting: 'bg-muted text-muted-foreground ring-border/50',
  };
</script>

<Seo
  title="Conversations"
  description="Every outreach and its reply — DMs and comment threads in one place."
/>

<PageHeader
  title="Conversations"
  description="Every outreach you've sent plus replies captured by the browser extension."
/>

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

  <div class="relative ml-auto w-64">
    <Search
      class="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
    />
    <Input
      bind:value={search}
      placeholder="Search handle or message"
      class="h-8 pl-8 text-xs"
    />
  </div>
</div>

<Card.Root size="sm">
  <Card.Content class="divide-y divide-border p-0">
    {#if data.conversations.length === 0}
      <div class="flex flex-col items-center gap-3 px-6 py-12 text-center">
        <div class="rounded-full bg-muted p-3 text-muted-foreground">
          <Inbox class="size-6" />
        </div>
        <p class="text-sm text-muted-foreground">No conversations yet.</p>
        <p class="max-w-sm text-xs text-muted-foreground">
          Once you send a DM and the browser extension picks up a reply, the thread will land here.
          Connect the extension from
          <a href="/settings" class="text-foreground hover:underline">Settings → Browser extension</a>.
        </p>
      </div>
    {:else if filtered.length === 0}
      <div class="px-6 py-10 text-center text-sm text-muted-foreground">
        No conversations match these filters.
      </div>
    {:else}
      {#each filtered as c (c.contactId)}
        {@const href = c.draftId != null ? `/inbox?state=all&focus=${c.draftId}` : null}
        <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
        <div
          role={href ? 'button' : undefined}
          tabindex={href ? 0 : undefined}
          aria-label={href ? `Open draft ${c.draftId} for u/${c.targetUser}` : undefined}
          onclick={() => href && goto(href)}
          onkeydown={(e) => {
            if (href && (e.key === 'Enter' || e.key === ' ')) {
              e.preventDefault();
              goto(href);
            }
          }}
          class={cn(
            'group flex items-start gap-3 px-4 py-3 transition-colors',
            href && 'cursor-pointer hover:bg-accent/40',
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
              <span class="font-mono text-sm font-medium">u/{c.targetUser}</span>
              {#if c.draftKind}
                <StatusBadge domain="draft-kind" value={c.draftKind} />
              {/if}
              {#if c.repliedAt}
                <StatusBadge domain="draft-state" value="replied" />
              {/if}
              <span class="text-xs text-muted-foreground">
                via u/{c.accountHandle} · {c.platformSlug}
              </span>
              <span
                class="ml-auto inline-flex items-center gap-2 text-[11px] text-muted-foreground/70"
              >
                {#if c.draftId != null}
                  <span class="group-hover:text-muted-foreground">Draft #{c.draftId}</span>
                {/if}
                <a
                  href={chatUrl(c.targetUser, c.chatRoomId)}
                  target="_blank"
                  rel="noopener"
                  onclick={(e) => e.stopPropagation()}
                  class="inline-flex items-center gap-1 rounded-md border border-border/60 px-2 py-0.5 text-foreground/80 transition-colors hover:border-primary/40 hover:bg-primary/10 hover:text-foreground"
                  title={c.chatRoomId
                    ? `Open Reddit chat with u/${c.targetUser}`
                    : `Open u/${c.targetUser}'s profile (chat room not yet captured — click Sync now in the popup once)`}
                >
                  <MessageSquare class="size-3" />
                  Reply
                </a>
              </span>
            </div>
            {#if c.lastMessage}
              <p class="mt-1 text-sm leading-snug">
                <span class="text-muted-foreground"
                  >{c.lastMessage.isFromUs ? 'you' : `u/${c.lastMessage.author}`}:</span
                >
                {snippet(c.lastMessage.body)}
              </p>
              <p class="mt-1 text-[11px] text-muted-foreground">
                {relativeTime(c.lastMessage.createdAt)}
              </p>
            {:else}
              <p class="mt-1 text-xs text-muted-foreground">
                Sent {relativeTime(c.lastContactedAt)} — no reply yet.
              </p>
            {/if}
          </div>
        </div>
      {/each}
    {/if}
  </Card.Content>
</Card.Root>
