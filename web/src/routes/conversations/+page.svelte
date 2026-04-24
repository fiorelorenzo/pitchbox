<script lang="ts">
  import PageHeader from '$lib/components/PageHeader.svelte';
  import Seo from '$lib/components/Seo.svelte';
  import StatusBadge from '$lib/components/StatusBadge.svelte';
  import * as Card from '$lib/components/ui/card';

  type Convo = {
    contactId: number;
    accountHandle: string;
    targetUser: string;
    platformSlug: string;
    lastContactedAt: string;
    repliedAt: string | null;
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

  function fmt(iso: string | Date): string {
    return new Date(iso).toLocaleString();
  }

  function snippet(s: string, n = 160): string {
    return s.length <= n ? s : s.slice(0, n - 1) + '…';
  }
</script>

<Seo
  title="Conversations"
  description="Every outreach and its reply — DMs and comment threads in one place."
/>

<PageHeader
  title="Conversations"
  description="Every outreach you've sent plus any replies captured by the browser extension."
/>

<Card.Root size="sm">
  <Card.Content class="divide-y divide-border p-0">
    {#if data.conversations.length === 0}
      <div class="p-8 text-center text-sm text-muted-foreground">
        No conversations yet. Once the extension syncs DM replies, they'll land here.
      </div>
    {:else}
      {#each data.conversations as c (c.contactId)}
        <div class="flex items-start gap-4 px-4 py-3">
          <div class="flex-1 min-w-0">
            <div class="flex items-center gap-2">
              <span class="font-mono text-sm">u/{c.targetUser}</span>
              <span class="text-xs text-muted-foreground">
                via u/{c.accountHandle} · {c.platformSlug}
              </span>
              {#if c.draftKind}
                <StatusBadge domain="draft-kind" value={c.draftKind} />
              {/if}
              {#if c.repliedAt}
                <StatusBadge domain="draft-state" value="replied" />
              {/if}
            </div>
            {#if c.lastMessage}
              <p class="mt-1 text-sm">
                <span class="text-muted-foreground"
                  >{c.lastMessage.isFromUs ? 'you' : `u/${c.lastMessage.author}`}:</span
                >
                {snippet(c.lastMessage.body)}
              </p>
              <p class="mt-1 text-xs text-muted-foreground">
                {fmt(c.lastMessage.createdAt)}
              </p>
            {:else}
              <p class="mt-1 text-xs text-muted-foreground">
                Sent {fmt(c.lastContactedAt)} — no reply yet.
              </p>
            {/if}
          </div>
          {#if c.draftId != null}
            <a
              href={`/inbox?focus=${c.draftId}`}
              class="text-xs text-muted-foreground hover:underline"
            >
              Draft #{c.draftId}
            </a>
          {/if}
        </div>
      {/each}
    {/if}
  </Card.Content>
</Card.Root>
