<script lang="ts">
	import PageHeader from '$lib/components/PageHeader.svelte';
	import Seo from '$lib/components/Seo.svelte';
	import * as Card from '$lib/components/ui/card';
	import * as Table from '$lib/components/ui/table';
	import { Input } from '$lib/components/ui/input';
	import { Button } from '$lib/components/ui/button';
	import { SelectField } from '$lib/components/ui/select-field';
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import { untrack } from 'svelte';

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
		nextCursor: { createdAt: string; id: string } | null;
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

	function loadMore() {
		if (!data.nextCursor) return;
		const params = new URLSearchParams($page.url.searchParams);
		params.set('cursor_at', data.nextCursor.createdAt);
		params.set('cursor_id', data.nextCursor.id);
		goto(`/audit?${params.toString()}`);
	}

	function fmt(d: string): string {
		const date = new Date(d);
		return date.toLocaleString();
	}
</script>

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
				{#each data.rows as r (r.kind + ':' + r.id)}
					<Table.Row>
						<Table.Cell class="text-xs font-mono text-muted-foreground"
							>{fmt(r.createdAt)}</Table.Cell
						>
						<Table.Cell>
							<span
								class="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold {r.kind ===
								'draft'
									? 'bg-sky-500/15 text-sky-700 dark:text-sky-300'
									: 'bg-violet-500/15 text-violet-700 dark:text-violet-300'}"
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
								<span class="text-muted-foreground">—</span>
							{/if}
						</Table.Cell>
						<Table.Cell class="text-xs">{r.actor ?? '—'}</Table.Cell>
					</Table.Row>
				{/each}
				{#if data.rows.length === 0}
					<Table.Row>
						<Table.Cell colspan={5} class="text-center text-sm text-muted-foreground py-8">
							No events match the current filters.
						</Table.Cell>
					</Table.Row>
				{/if}
			</Table.Body>
		</Table.Root>
		{#if data.nextCursor}
			<div class="flex justify-center py-3">
				<Button variant="outline" onclick={loadMore}>Load more</Button>
			</div>
		{/if}
	</Card.Content>
</Card.Root>
