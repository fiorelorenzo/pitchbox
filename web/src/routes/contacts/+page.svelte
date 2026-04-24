<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import { Search } from 'lucide-svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import { Badge } from '$lib/components/ui/badge';
	import { Input } from '$lib/components/ui/input';
	import { SelectField } from '$lib/components/ui/select-field';
	import * as Card from '$lib/components/ui/card';
	import * as Table from '$lib/components/ui/table';
	import { relativeTime } from '$lib/utils/time';

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

	let {
		data,
	}: {
		data: {
			contacts: Contact[];
			platforms: Platform[];
			filters: { platform: string | null; q: string };
			totals: { unique: number; total: number; replied: number };
		};
	} = $props();

	let query = $derived(data.filters.q);

	const platformOptions = $derived([
		{ value: '', label: 'All platforms' },
		...data.platforms.map((p) => ({ value: p.slug, label: p.slug })),
	]);

	function navigate(params: Record<string, string | null>) {
		const url = new URL($page.url);
		for (const [k, v] of Object.entries(params)) {
			if (v === null || v === '') url.searchParams.delete(k);
			else url.searchParams.set(k, v);
		}
		goto(url.pathname + url.search, { invalidateAll: true, replaceState: true });
	}

	function onSearchKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter') navigate({ q: query });
	}

	function urlForDraft(targetUser: string, draftId: number | null): string {
		if (draftId != null) return `/inbox?state=all&run=${$page.url.searchParams.get('run') ?? ''}#${draftId}`;
		return `/inbox?state=sent&q=${encodeURIComponent(targetUser)}`;
	}
</script>

<PageHeader
	title="Contacts"
	description="Everyone your campaigns have messaged, posted to, or commented on. {data.totals.unique} unique across {data.totals.total} contacts — {data.totals.replied} replied."
/>

<Card.Root size="sm">
	<Card.Header class="flex-row items-center justify-between space-y-0 gap-3 flex-wrap">
		<div class="flex items-center gap-3 flex-wrap">
			<SelectField
				value={data.filters.platform ?? ''}
				options={platformOptions}
				onValueChange={(v) => navigate({ platform: v ? String(v) : null })}
			/>
			<div class="relative">
				<Search
					class="size-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none"
				/>
				<Input
					bind:value={query}
					onkeydown={onSearchKeydown}
					placeholder="Search target user…"
					class="h-9 w-64 pl-8"
				/>
			</div>
		</div>
		<span class="text-xs text-muted-foreground">
			{data.contacts.length} rows shown
		</span>
	</Card.Header>
	<Card.Content>
		{#if data.contacts.length === 0}
			<p class="text-sm text-muted-foreground italic py-10 text-center">
				No contacts yet. Mark drafts as sent to populate this table.
			</p>
		{:else}
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
					{#each data.contacts as c (c.id)}
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
							<Table.Cell>
								{#if c.draftKind}
									<Badge variant="outline" class="text-[10px]">{c.draftKind}</Badge>
								{:else}
									<span class="text-xs text-muted-foreground italic">—</span>
								{/if}
							</Table.Cell>
							<Table.Cell class="text-xs text-muted-foreground" title={String(c.lastContactedAt)}>
								{relativeTime(c.lastContactedAt)}
							</Table.Cell>
							<Table.Cell>
								{#if c.repliedAt}
									<Badge class="text-[10px] bg-emerald-500/90 hover:bg-emerald-500/90">
										replied {relativeTime(c.repliedAt)}
									</Badge>
								{:else if c.replyCheckedAt}
									<span class="text-[10px] text-muted-foreground">no reply yet</span>
								{:else}
									<span class="text-[10px] text-muted-foreground italic">unchecked</span>
								{/if}
							</Table.Cell>
							<Table.Cell class="text-right">
								{#if c.draftId != null}
									<a
										href="/inbox?state=all"
										onclick={(e) => {
											e.preventDefault();
											goto(urlForDraft(c.targetUser, c.draftId));
										}}
										class="text-xs text-primary hover:underline"
									>
										#{c.draftId}
									</a>
								{:else}
									<span class="text-xs text-muted-foreground">—</span>
								{/if}
							</Table.Cell>
						</Table.Row>
					{/each}
				</Table.Body>
			</Table.Root>
		{/if}
	</Card.Content>
</Card.Root>
