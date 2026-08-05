<script lang="ts">
	import PageHeader from '$lib/components/PageHeader.svelte';
	import Seo from '$lib/components/Seo.svelte';
	import * as Card from '$lib/components/ui/card';
	import * as Table from '$lib/components/ui/table';
	import { Input } from '$lib/components/ui/input';
	import { Button } from '$lib/components/ui/button';
	import { SelectField } from '$lib/components/ui/select-field';
	import { AlertTriangle } from '@lucide/svelte';
	import { toast } from 'svelte-sonner';
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import { untrack } from 'svelte';
	import PageContainer from '$lib/components/PageContainer.svelte';
	import { TONE_CLASS, TONE_BANNER_CLASS } from '$lib/config/status-badges';

	type Row = {
		kind: 'draft' | 'run';
		id: string;
		event: string;
		actor: string | null;
		draftId: number | null;
		runId: number | null;
		details: unknown;
		createdAt: string;
	};

	type Cursor = { createdAt: string; id: string } | null;

	type PageData = {
		rows: Row[];
		eventTypes: string[];
		filters: {
			actor: string;
			event: string;
			draftId: number | '';
			runId: number | '';
			from: string;
			to: string;
		};
		nextCursor: Cursor;
	};

	let { data }: { data: PageData } = $props();

	let event = $state(untrack(() => data.filters.event));
	let draftId = $state(
		untrack(() => (data.filters.draftId === '' ? '' : String(data.filters.draftId))),
	);
	let runId = $state(
		untrack(() => (data.filters.runId === '' ? '' : String(data.filters.runId))),
	);
	let actor = $state(untrack(() => data.filters.actor));
	let from = $state(untrack(() => data.filters.from));
	let to = $state(untrack(() => data.filters.to));

	const eventOptions = $derived([
		{ value: '', label: 'All events' },
		...data.eventTypes.map((e) => ({ value: e, label: e })),
	]);

	// Accumulated rows across every "Load more" click. Reset whenever `data`
	// itself changes underneath us - a real navigation (filters applied/reset)
	// or `invalidateAll()` - so the list always starts back at page one of
	// whatever is now selected.
	let items = $state<Row[]>([]);
	let itemsNextCursor = $state<Cursor>(null);
	let loadingMore = $state(false);
	let loadMoreError = $state<string | null>(null);

	$effect(() => {
		items = data.rows;
		itemsNextCursor = data.nextCursor;
		loadMoreError = null;
	});

	function applyFilters() {
		const params = new URLSearchParams();
		if (event) params.set('event', event);
		if (draftId) params.set('draft_id', draftId);
		if (runId) params.set('run_id', runId);
		if (actor) params.set('actor', actor);
		if (from) params.set('from', from);
		if (to) params.set('to', to);
		const qs = params.toString();
		goto(qs ? `/audit?${qs}` : '/audit', { replaceState: false, keepFocus: true });
	}

	// Fetches the next page and appends it - no navigation, so scroll
	// position is kept and the rows already on screen never disappear. The
	// cursor rides only on this fetch's URL, never on `$page.url` (that copy
	// of the search params never carries `cursor_at`/`cursor_id`), so a
	// shared link always starts at page one of whatever filters it encodes.
	async function loadMore() {
		if (!itemsNextCursor || loadingMore) return;
		loadingMore = true;
		loadMoreError = null;
		try {
			const params = new URLSearchParams($page.url.searchParams);
			params.set('cursor_at', itemsNextCursor.createdAt);
			params.set('cursor_id', itemsNextCursor.id);
			const res = await fetch(`/audit?${params.toString()}`, {
				headers: { accept: 'application/json' },
			});
			if (!res.ok) {
				const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
				const message =
					res.status >= 500
						? 'Could not load more events. Please try again.'
						: (body.error ?? body.message ?? 'Could not load more events.');
				if (res.status >= 500) console.error('failed to load more audit events', res.status, body);
				loadMoreError = message;
				toast.error(message);
				return;
			}
			const nextPage = (await res.json()) as { rows: Row[]; nextCursor: Cursor };
			items = [...items, ...nextPage.rows];
			itemsNextCursor = nextPage.nextCursor;
		} catch {
			loadMoreError = 'Could not reach the server. Check your connection and try again.';
			toast.error(loadMoreError);
		} finally {
			loadingMore = false;
		}
	}

	function fmt(d: string): string {
		const date = new Date(d);
		return date.toLocaleString();
	}
</script>

<PageContainer size="wide">
<Seo title="Audit" description="Unified audit log of draft and run events." />

<PageHeader title="Audit log" description="Time-ordered feed of draft and run events." />

<Card.Root size="sm" class="mt-4">
	<Card.Content class="grid grid-cols-1 md:grid-cols-6 gap-3 py-3">
		<div class="flex flex-col gap-1">
			<label for="audit-event" class="text-xs text-muted-foreground">Event</label>
			<SelectField bind:value={event} options={eventOptions} fullWidth />
		</div>
		<div class="flex flex-col gap-1">
			<label for="audit-draft" class="text-xs text-muted-foreground">Draft ID</label>
			<Input id="audit-draft" bind:value={draftId} placeholder="123" inputmode="numeric" />
		</div>
		<div class="flex flex-col gap-1">
			<label for="audit-run" class="text-xs text-muted-foreground">Run ID</label>
			<Input id="audit-run" bind:value={runId} placeholder="456" inputmode="numeric" />
		</div>
		<div class="flex flex-col gap-1">
			<label for="audit-actor" class="text-xs text-muted-foreground">Actor</label>
			<Input id="audit-actor" bind:value={actor} placeholder="user-id or 'agent'" />
		</div>
		<div class="flex flex-col gap-1">
			<label for="audit-from" class="text-xs text-muted-foreground">From</label>
			<Input id="audit-from" type="date" bind:value={from} />
		</div>
		<div class="flex flex-col gap-1">
			<label for="audit-to" class="text-xs text-muted-foreground">To</label>
			<Input id="audit-to" type="date" bind:value={to} />
		</div>
		<div class="md:col-span-6 flex justify-end gap-2">
			<Button
				variant="ghost"
				onclick={() => {
					event = '';
					draftId = '';
					runId = '';
					actor = '';
					from = '';
					to = '';
					goto('/audit');
				}}>Reset</Button
			>
			<Button onclick={applyFilters}>Apply</Button>
		</div>
	</Card.Content>
</Card.Root>

<Card.Root size="sm" class="mt-4">
	<Card.Content class="py-2">
		<Table.Root>
			<Table.Header>
				<Table.Row>
					<Table.Head class="w-44">Timestamp</Table.Head>
					<Table.Head class="w-20">Kind</Table.Head>
					<Table.Head>Event</Table.Head>
					<Table.Head>Target</Table.Head>
					<Table.Head>Actor</Table.Head>
				</Table.Row>
			</Table.Header>
			<Table.Body>
				{#each items as r (r.kind + ':' + r.id)}
					<Table.Row>
						<Table.Cell class="text-xs font-mono text-muted-foreground"
							>{fmt(r.createdAt)}</Table.Cell
						>
						<Table.Cell>
							<span
								class="inline-flex items-center rounded-full ring-1 ring-inset px-2 py-0.5 text-[10px] font-semibold {TONE_CLASS[
									r.kind === 'draft' ? 'sky' : 'violet'
								]}"
							>
								{r.kind}
							</span>
						</Table.Cell>
						<Table.Cell class="font-mono text-xs">{r.event}</Table.Cell>
						<Table.Cell class="text-xs">
							{#if r.draftId !== null}
								<a class="underline hover:no-underline" href="/inbox?draft={r.draftId}"
									>draft #{r.draftId}</a
								>
							{:else if r.runId !== null}
								<a class="underline hover:no-underline" href="/campaigns?run={r.runId}"
									>run #{r.runId}</a
								>
							{:else}
								<span class="text-muted-foreground">-</span>
							{/if}
						</Table.Cell>
						<Table.Cell class="text-xs">{r.actor ?? '-'}</Table.Cell>
					</Table.Row>
				{/each}
				{#if items.length === 0}
					<Table.Row>
						<Table.Cell colspan={5} class="text-center text-sm text-muted-foreground py-8">
							No events match the current filters.
						</Table.Cell>
					</Table.Row>
				{/if}
			</Table.Body>
		</Table.Root>
		{#if itemsNextCursor}
			<div class="flex flex-col items-center gap-2 py-3">
				<Button variant="outline" onclick={loadMore} loading={loadingMore}>Load more</Button>
				{#if loadMoreError}
					<div
						role="alert"
						class="flex max-w-sm items-start gap-2 rounded-lg border px-3 py-2 text-xs {TONE_BANNER_CLASS.rose}"
					>
						<AlertTriangle class="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
						<div class="flex-1">
							<p>{loadMoreError}</p>
							<button
								type="button"
								onclick={loadMore}
								class="mt-1 underline underline-offset-2 hover:no-underline"
							>
								Retry
							</button>
						</div>
					</div>
				{/if}
			</div>
		{/if}
	</Card.Content>
</Card.Root>
</PageContainer>
