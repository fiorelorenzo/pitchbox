<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/stores';
  import { Search, Users, MessageSquare, AlertTriangle } from '@lucide/svelte';
  import { toast } from 'svelte-sonner';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import Seo from '$lib/components/Seo.svelte';
  import EmptyState from '$lib/components/EmptyState.svelte';
  import ChatSyncStalledBanner from '$lib/components/ChatSyncStalledBanner.svelte';
  import ExtensionDeviceNudgeBanner from '$lib/components/ExtensionDeviceNudgeBanner.svelte';
  import { Input } from '$lib/components/ui/input';
  import { Button } from '$lib/components/ui/button';
  import { SelectField } from '$lib/components/ui/select-field';
  import * as Card from '$lib/components/ui/card';
  import * as Table from '$lib/components/ui/table';
  import * as Tabs from '$lib/components/ui/tabs';
  import { relativeTime } from '$lib/utils/time';
  import { cn } from '$lib/utils';
  import { replyUrl } from '$lib/utils/reply-url';
  import { getPresenter } from '$lib/platforms/presenter';
  import { encodeThreadId } from '../conversations/[id]/thread-id';
  import StatusBadge from '$lib/components/StatusBadge.svelte';
  import PageContainer from '$lib/components/PageContainer.svelte';
  import { resolveTone, TONE_CLASS, TONE_BANNER_CLASS } from '$lib/config/status-badges';

  type Contact = {
    id: number;
    platformId: number;
    platformSlug: string | null;
    accountHandle: string;
    targetUser: string;
    lastContactedAt: string | Date;
    repliedAt: string | Date | null;
    replyCheckedAt: string | Date | null;
    draftId: number | null;
    draftKind: string | null;
    draftRunId: number | null;
    draftState: string | null;
  };
  type Platform = { id: number; slug: string };
  type ContactsCursor = { lastContactedAt: string; id: string } | null;

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
  type ThreadsCursor = { sortAt: string; id: string } | null;

  type Tab = 'threads' | 'contacts';

  type ContactsData = {
    tab: 'contacts';
    contacts: Contact[];
    platforms: Platform[];
    filters: { platform: string | null; q: string };
    totals: { unique: number; total: number; replied: number };
    nextCursor: ContactsCursor;
    matchingCount: number;
  };
  type ThreadsData = {
    tab: 'threads';
    conversations: Convo[];
    filters: { filter: string; kind: string; q: string };
    counts: { all: number; replied: number; awaiting: number };
    nextCursor: ThreadsCursor;
    chatSyncUnauthorized?: boolean;
    extensionNudge?: { kind: 'no_device' | 'stale_device' } | null;
    orgId?: number | null;
  };

  let { data }: { data: ContactsData | ThreadsData } = $props();

  // The tab lives in the URL (`?tab=contacts`, absent = threads) so it
  // survives reload and back/forward exactly like the filter/kind/q params
  // both tabs already carry - never local component state on its own.
  function setTab(next: Tab) {
    const url = new URL($page.url);
    if (next === 'threads') url.searchParams.delete('tab');
    else url.searchParams.set('tab', next);
    goto(url, { replaceState: true, noScroll: true, keepFocus: true });
  }

  let headerDescription = $derived(
    data.tab === 'contacts'
      ? `Everyone your campaigns have messaged, posted to, or commented on. ${data.totals.unique} unique across ${data.totals.total} contacts - ${data.totals.replied} replied.`
      : "Every outreach you've sent plus replies captured by the browser extension.",
  );

  // ---- Contacts tab ("All contacts") ----------------------------------

  let contactsQuery = $derived(data.tab === 'contacts' ? data.filters.q : '');

  const contactsPlatformOptions = $derived(
    data.tab === 'contacts'
      ? [
          { value: '', label: 'All platforms' },
          ...data.platforms.map((p) => ({ value: p.slug, label: p.slug })),
        ]
      : [],
  );

  // Accumulated rows across every "Load more" click. Reset whenever `data`
  // itself changes underneath us - a real navigation (filter/search/tab
  // applied) - so the list always starts back at page one of whatever is
  // now selected.
  let contactsItems = $state<Contact[]>([]);
  let contactsMatchingCount = $state(0);
  let contactsNextCursor = $state<ContactsCursor>(null);
  let contactsLoadingMore = $state(false);
  let contactsLoadMoreError = $state<string | null>(null);

  let threadsItems = $state<Convo[]>([]);
  let threadsNextCursor = $state<ThreadsCursor>(null);
  let threadsLoadingMore = $state(false);
  let threadsLoadMoreError = $state<string | null>(null);

  function contactsNavigate(params: Record<string, string | null>) {
    const url = new URL($page.url);
    for (const [k, v] of Object.entries(params)) {
      if (v === null || v === '') url.searchParams.delete(k);
      else url.searchParams.set(k, v);
    }
    goto(url.pathname + url.search, { invalidateAll: true, replaceState: true });
  }

  function contactsSearchKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') contactsNavigate({ q: contactsQuery });
  }

  // Fetches the next page and appends it - no navigation, so scroll
  // position is kept and the rows already on screen never disappear. The
  // cursor rides only on this fetch's URL, never on `$page.url` (that copy
  // of the search params never carries `cursor_at`/`cursor_id`), so a
  // shared link always starts at page one of whatever filters it encodes.
  // Backed directly by the old /contacts route's own JSON endpoint - same
  // query module as this tab's first page, so the two can never drift.
  async function contactsLoadMore() {
    if (!contactsNextCursor || contactsLoadingMore) return;
    contactsLoadingMore = true;
    contactsLoadMoreError = null;
    try {
      const params = new URLSearchParams($page.url.searchParams);
      params.delete('tab');
      params.set('cursor_at', contactsNextCursor.lastContactedAt);
      params.set('cursor_id', contactsNextCursor.id);
      const res = await fetch(`/contacts?${params.toString()}`, {
        headers: { accept: 'application/json' },
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
        const message =
          res.status >= 500
            ? 'Could not load more contacts. Please try again.'
            : (body.error ?? body.message ?? 'Could not load more contacts.');
        if (res.status >= 500) console.error('failed to load more contacts', res.status, body);
        contactsLoadMoreError = message;
        toast.error(message);
        return;
      }
      const nextPage = (await res.json()) as {
        contacts: Contact[];
        matchingCount: number;
        nextCursor: ContactsCursor;
      };
      contactsItems = [...contactsItems, ...nextPage.contacts];
      contactsMatchingCount = nextPage.matchingCount;
      contactsNextCursor = nextPage.nextCursor;
    } catch {
      contactsLoadMoreError = 'Could not reach the server. Check your connection and try again.';
      toast.error(contactsLoadMoreError);
    } finally {
      contactsLoadingMore = false;
    }
  }

  function urlForDraft(draftId: number | null): string {
    // `?draft=<id>` is the deep-link the inbox reads to select + scroll a
    // draft into view - same param Search and Audit produce. Without a
    // draftId there is nothing to deep-link to (the inbox has no free-text
    // search, so a `?q=` param here would be emitted but never read -
    // #239): fall back to the sent-state filter alone.
    if (draftId != null) return `/inbox?draft=${draftId}`;
    return `/inbox?state=sent`;
  }

  // ---- Threads tab ("Threads") -----------------------------------------

  type Filter = 'all' | 'replied' | 'awaiting';
  let threadsFilter = $derived(data.tab === 'threads' ? (data.filters.filter as Filter) : 'all');
  // Seeded by the $effect below, which runs on mount too (previousTab starts
  // null, so the "transition INTO Threads" branch fires) and on every later
  // transition into this tab. Reading `data` here as well would capture only
  // its initial value.
  let threadsSearch = $state('');
  // Tracks the tab active on the previous run so a transition INTO Threads
  // resyncs `threadsSearch` from the fresh `data.filters.q` (the same
  // "component just mounted" moment the old standalone /conversations page
  // relied on for its own `$state(data.filters.q)` init) - but staying on
  // Threads across a kind/filter switch leaves whatever the user is mid-
  // typing alone, exactly like that old page did.
  let previousTab: Tab | null = null;
  $effect(() => {
    if (data.tab === 'contacts') {
      contactsItems = data.contacts;
      contactsMatchingCount = data.matchingCount;
      contactsNextCursor = data.nextCursor;
      contactsLoadMoreError = null;
    } else {
      threadsItems = data.conversations;
      threadsNextCursor = data.nextCursor;
      threadsLoadMoreError = null;
      if (previousTab !== 'threads') threadsSearch = data.filters.q;
    }
    previousTab = data.tab;
  });

  function threadsSetFilter(next: Filter) {
    const url = new URL($page.url);
    if (next === 'all') url.searchParams.delete('filter');
    else url.searchParams.set('filter', next);
    goto(url, { replaceState: true, noScroll: true, keepFocus: true });
  }

  function truncateBody(s: string, n = 180): string {
    return s.length <= n ? s : s.slice(0, n - 1) + '…';
  }

  function initials(handle: string): string {
    return handle.slice(0, 2).toUpperCase();
  }

  type KindFilter = 'all' | 'dm' | 'post_comment';
  let threadsKindFilter = $derived(data.tab === 'threads' ? (data.filters.kind as KindFilter) : 'all');
  function threadsSetKindFilter(next: KindFilter) {
    const url = new URL($page.url);
    if (next === 'all') url.searchParams.delete('kind');
    else url.searchParams.set('kind', next);
    goto(url, { replaceState: true, noScroll: true, keepFocus: true });
  }

  // The search box used to filter client-side over the fetched window; now
  // it is a query param applied on the server before the page cut, so it
  // needs an explicit trigger (Enter) instead of filtering on every
  // keystroke - same convention as the Contacts tab's search input.
  function threadsApplySearch() {
    const url = new URL($page.url);
    if (threadsSearch.trim()) url.searchParams.set('q', threadsSearch.trim());
    else url.searchParams.delete('q');
    goto(url, { replaceState: true, noScroll: true, keepFocus: true });
  }

  function threadsSearchKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') threadsApplySearch();
  }

  // Backed directly by the old /conversations route's own JSON endpoint -
  // same query module (including the message-body search) as this tab's
  // first page, so the two can never drift. Paging one tab never touches
  // the other's cursor: each keeps its own `*NextCursor` state above.
  async function threadsLoadMore() {
    if (!threadsNextCursor || threadsLoadingMore) return;
    threadsLoadingMore = true;
    threadsLoadMoreError = null;
    try {
      const params = new URLSearchParams($page.url.searchParams);
      params.delete('tab');
      params.set('cursor_at', threadsNextCursor.sortAt);
      params.set('cursor_id', threadsNextCursor.id);
      const res = await fetch(`/conversations?${params.toString()}`, {
        headers: { accept: 'application/json' },
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
        const message =
          res.status >= 500
            ? 'Could not load more conversations. Please try again.'
            : (body.error ?? body.message ?? 'Could not load more conversations.');
        if (res.status >= 500) console.error('failed to load more conversations', res.status, body);
        threadsLoadMoreError = message;
        toast.error(message);
        return;
      }
      const nextPage = (await res.json()) as { conversations: Convo[]; nextCursor: ThreadsCursor };
      threadsItems = [...threadsItems, ...nextPage.conversations];
      threadsNextCursor = nextPage.nextCursor;
    } catch {
      threadsLoadMoreError = 'Could not reach the server. Check your connection and try again.';
      toast.error(threadsLoadMoreError);
    } finally {
      threadsLoadingMore = false;
    }
  }
</script>

<PageContainer size="default">
<Seo
  title="People"
  description="Everyone your campaigns have reached, and every conversation with them - one destination instead of a guess between two."
/>

<PageHeader title="People" description={headerDescription} />

<Tabs.Root value={data.tab} onValueChange={(v) => setTab(v as Tab)} class="mb-4">
  <Tabs.List>
    <Tabs.Trigger value="threads">Threads</Tabs.Trigger>
    <Tabs.Trigger value="contacts">All contacts</Tabs.Trigger>
  </Tabs.List>
</Tabs.Root>

{#if data.tab === 'threads'}
  <ChatSyncStalledBanner show={!!data.chatSyncUnauthorized} />
  <ExtensionDeviceNudgeBanner kind={data.extensionNudge?.kind ?? null} orgId={data.orgId ?? null} />

  <div class="mb-4 flex flex-wrap items-center gap-2">
    {#each [{ key: 'all', label: 'All' }, { key: 'awaiting', label: 'Awaiting reply' }, { key: 'replied', label: 'Replied' }] as f (f.key)}
      {@const active = threadsFilter === f.key}
      <button
        type="button"
        onclick={() => threadsSetFilter(f.key as Filter)}
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
          {data.counts[f.key as Filter]}
        </span>
      </button>
    {/each}

    <div class="relative w-full sm:ml-auto sm:w-64">
      <Search
        class="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
      />
      <Input
        bind:value={threadsSearch}
        onkeydown={threadsSearchKeydown}
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
        qs.delete('tab');
        qs.set('format', 'csv');
        window.location.href = `/api/export/conversations?${qs.toString()}`;
      }}
    >
      Export CSV
    </Button>
  </div>

  <div class="mb-4 flex flex-wrap items-center gap-2">
    {#each [{ key: 'all', label: 'All kinds' }, { key: 'dm', label: 'DMs' }, { key: 'post_comment', label: 'Comments' }] as k (k.key)}
      {@const active = threadsKindFilter === k.key}
      <button
        type="button"
        onclick={() => threadsSetKindFilter(k.key as KindFilter)}
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
      {#if data.counts.all === 0}
        <EmptyState
          icon={MessageSquare}
          title="No conversations yet"
          description="Once you send a DM or a comment-reply and the browser extension picks up an inbound message, the thread will land here. Pair the extension from the side panel to start syncing."
        />
      {:else if threadsItems.length === 0}
        <EmptyState
          icon={Search}
          title="No matches"
          description="No conversations match the current filters. Try clearing the search or switching the kind filter."
          size="sm"
        />
      {:else}
        {#each threadsItems as c (c.contactId)}
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
                TONE_CLASS[resolveTone('contact-status', c.repliedAt ? 'replied' : 'no_reply')],
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
                  {truncateBody(c.lastMessage.body)}
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
        {#if threadsNextCursor}
          <div class="flex flex-col items-center gap-2 py-3">
            <Button variant="outline" size="sm" onclick={threadsLoadMore} loading={threadsLoadingMore}>
              Load more
            </Button>
            {#if threadsLoadMoreError}
              <div
                role="alert"
                class="flex max-w-sm items-start gap-2 rounded-lg border px-3 py-2 text-xs {TONE_BANNER_CLASS.rose}"
              >
                <AlertTriangle class="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                <div class="flex-1">
                  <p>{threadsLoadMoreError}</p>
                  <button
                    type="button"
                    onclick={threadsLoadMore}
                    class="mt-1 underline underline-offset-2 hover:no-underline"
                  >
                    Retry
                  </button>
                </div>
              </div>
            {/if}
          </div>
        {/if}
      {/if}
    </Card.Content>
  </Card.Root>
{:else}
  <Card.Root size="sm">
    <Card.Header class="flex-row items-center justify-between space-y-0 gap-3 flex-wrap">
      <div class="flex items-center gap-3 flex-wrap">
        <SelectField
          value={data.filters.platform ?? ''}
          options={contactsPlatformOptions}
          onValueChange={(v) => contactsNavigate({ platform: v ? String(v) : null })}
        />
        <div class="relative">
          <Search
            class="size-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none"
          />
          <Input
            bind:value={contactsQuery}
            onkeydown={contactsSearchKeydown}
            placeholder="Search target user…"
            class="h-9 w-full sm:w-64 pl-8"
          />
        </div>
      </div>
      <div class="flex items-center gap-3">
        <span class="text-xs text-muted-foreground">
          {contactsItems.length} of {contactsMatchingCount} shown
        </span>
        <Button
          variant="outline"
          size="sm"
          onclick={() => {
            // Mirror the current contacts filters into the export URL.
            const qs = new URLSearchParams($page.url.searchParams);
            qs.delete('tab');
            qs.set('format', 'csv');
            window.location.href = `/api/export/contacts?${qs.toString()}`;
          }}
        >
          Export CSV
        </Button>
      </div>
    </Card.Header>
    <Card.Content>
      {#if contactsItems.length === 0}
        <EmptyState
          icon={Users}
          title="No contacts yet"
          description="Every time a draft is marked as sent, the target lands here with first-seen / last-seen timestamps. Run a campaign and approve a draft to populate the table."
        />
      {:else}
{#snippet kindCell(c: Contact)}
	{#if c.draftKind}
		<StatusBadge domain="draft-kind" value={c.draftKind} />
	{:else}
		<span class="text-xs text-muted-foreground italic">-</span>
	{/if}
{/snippet}

{#snippet replyCell(c: Contact)}
	{#if c.repliedAt}
		<span class="inline-flex items-center gap-1.5">
			<StatusBadge domain="contact-status" value="replied" />
			<span class="text-[10px] text-muted-foreground tabular-nums">
				{relativeTime(c.repliedAt)}
			</span>
		</span>
	{:else if c.replyCheckedAt}
		<span class="text-[10px] text-muted-foreground">no reply yet</span>
	{:else}
		<span class="text-[10px] text-muted-foreground italic">unchecked</span>
	{/if}
{/snippet}

{#snippet draftCell(c: Contact)}
	{#if c.draftId != null}
		<a
			href={urlForDraft(c.draftId)}
			onclick={(e) => {
				e.preventDefault();
				goto(urlForDraft(c.draftId));
			}}
			class="text-xs text-primary hover:underline"
		>
			#{c.draftId}
		</a>
	{:else}
		<span class="text-xs text-muted-foreground">-</span>
	{/if}
{/snippet}

<!-- md and up: table, unchanged layout -->
<div class="hidden md:block">
<Table.Root>
	<Table.Header>
		<Table.Row>
			<Table.Head>Target</Table.Head>
			<Table.Head>Platform</Table.Head>
			<Table.Head>From account</Table.Head>
			<Table.Head>Kind</Table.Head>
			<Table.Head>Last contacted</Table.Head>
			<Table.Head>Reply</Table.Head>
			<Table.Head class="text-right">Draft</Table.Head>
		</Table.Row>
	</Table.Header>
	<Table.Body>
		{#each contactsItems as c (c.id)}
			<Table.Row>
				<Table.Cell class="font-medium">
					{c.platformSlug === 'reddit' ? `u/${c.targetUser}` : c.targetUser}
				</Table.Cell>
				<Table.Cell class="text-xs text-muted-foreground">
					{c.platformSlug ?? `#${c.platformId}`}
				</Table.Cell>
				<Table.Cell class="text-xs text-muted-foreground">
					{c.accountHandle}
				</Table.Cell>
				<Table.Cell>{@render kindCell(c)}</Table.Cell>
				<Table.Cell class="text-xs text-muted-foreground" title={String(c.lastContactedAt)}>
					{relativeTime(c.lastContactedAt)}
				</Table.Cell>
				<Table.Cell>{@render replyCell(c)}</Table.Cell>
				<Table.Cell class="text-right">{@render draftCell(c)}</Table.Cell>
			</Table.Row>
		{/each}
	</Table.Body>
</Table.Root>
</div>

<!-- Below md: one card per contact, nothing off-screen (#244) -->
<div class="md:hidden flex flex-col gap-3">
	{#each contactsItems as c (c.id)}
		<div class="rounded-lg border border-border p-3 space-y-2">
			<div class="flex items-start justify-between gap-2">
				<span class="font-medium text-sm truncate">
					{c.platformSlug === 'reddit' ? `u/${c.targetUser}` : c.targetUser}
				</span>
				{@render draftCell(c)}
			</div>
			<div class="text-xs text-muted-foreground">
				{c.platformSlug ?? `#${c.platformId}`} · {c.accountHandle}
			</div>
			<div class="flex items-center gap-2 flex-wrap">
				{@render kindCell(c)}
				{@render replyCell(c)}
			</div>
			<div class="text-xs text-muted-foreground" title={String(c.lastContactedAt)}>
				Last contacted {relativeTime(c.lastContactedAt)}
			</div>
		</div>
	{/each}
</div>

{#if contactsNextCursor}
	<div class="flex flex-col items-center gap-2 py-3">
		<Button variant="outline" size="sm" onclick={contactsLoadMore} loading={contactsLoadingMore}>Load more</Button>
		{#if contactsLoadMoreError}
			<div
				role="alert"
				class="flex max-w-sm items-start gap-2 rounded-lg border px-3 py-2 text-xs {TONE_BANNER_CLASS.rose}"
			>
				<AlertTriangle class="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
				<div class="flex-1">
					<p>{contactsLoadMoreError}</p>
					<button
						type="button"
						onclick={contactsLoadMore}
						class="mt-1 underline underline-offset-2 hover:no-underline"
					>
						Retry
					</button>
				</div>
			</div>
		{/if}
	</div>
{/if}
      {/if}
    </Card.Content>
  </Card.Root>
{/if}
</PageContainer>
