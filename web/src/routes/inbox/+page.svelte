<script lang="ts">
	import DraftListItem from '$lib/components/DraftListItem.svelte';
	import DraftDetail from '$lib/components/DraftDetail.svelte';
	import { onMount } from 'svelte';
	import { invalidateAll, goto } from '$app/navigation';
	import { navigating, page } from '$app/stores';
	import { ChevronDown, X, Inbox, Keyboard } from 'lucide-svelte';
	import { Button } from '$lib/components/ui/button';
	import { Badge } from '$lib/components/ui/badge';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import * as Card from '$lib/components/ui/card';
	import * as Tabs from '$lib/components/ui/tabs';
	import * as Dialog from '$lib/components/ui/dialog';
	import * as AlertDialog from '$lib/components/ui/alert-dialog';
	import { toast } from 'svelte-sonner';
	import { relativeTime } from '$lib/utils/time';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import Seo from '$lib/components/Seo.svelte';

	import type { UsageByKind, QuotaLimits } from '@pitchbox/shared/quota';

	let {
		data,
	}: {
		data: {
			drafts: Array<{
				id: number;
				accountId: number;
				runId: number;
				kind: string;
				targetUser: string | null;
				subreddit: string | null;
				fitScore: number | null;
				state: string;
				body: string;
				composeUrl: string | null;
				reasoning: string | null;
				createdAt: string | Date | null;
				sentAt: string | Date | null;
				sentContent: string | null;
			}>;
			state: string;
			kind: string | null;
			run: string | null;
			campaign: string | null;
			runInfo: { id: number; campaignId: number; status: string; startedAt: Date | string; campaignName: string | null } | null;
			campaignInfo: { id: number; name: string } | null;
			usage: Record<number, UsageByKind>;
			quotaLimits: QuotaLimits | null;
		};
	} = $props();

	let selectedId = $state<number | null>(null);
	$effect(() => {
		// `?focus=N` (e.g. coming from Conversations) wins over the default selection.
		const focusParam = $page.url.searchParams.get('focus');
		const focusId = focusParam ? Number(focusParam) : null;
		if (focusId && data.drafts.find((d) => d.id === focusId)) {
			selectedId = focusId;
			return;
		}
		// When drafts list changes, select first if nothing selected
		if (data.drafts.length > 0 && (selectedId === null || !data.drafts.find((d) => d.id === selectedId))) {
			selectedId = data.drafts[0].id;
		} else if (data.drafts.length === 0) {
			selectedId = null;
		}
	});
	let selected = $derived(data.drafts.find((d) => d.id === selectedId) ?? null);
	let selectedIndex = $derived(data.drafts.findIndex((d) => d.id === selectedId));
	let pendingCount = $derived(data.drafts.filter((d) => d.state === 'pending_review').length);

	// Checkbox selection for bulk actions
	let checkedIds = $state<Set<number>>(new Set());
	let rejectConfirmOpen = $state(false);
	let rejectBulk = $state(false); // true = reject all checked, false = reject single current

	// Shortcuts dialog
	let shortcutsOpen = $state(false);

	const KINDS = [
		{ value: null, label: 'All' },
		{ value: 'dm', label: 'DMs' },
		{ value: 'post', label: 'Posts' },
		{ value: 'post_comment', label: 'Comments' },
		{ value: 'comment_reply', label: 'Replies' },
	];

	const STATES = [
		{ value: 'pending_review', label: 'Pending review' },
		{ value: 'approved', label: 'Approved' },
		{ value: 'sent', label: 'Sent' },
		{ value: 'rejected', label: 'Rejected' },
		{ value: 'all', label: 'All' },
	];

	let kindLabel = $derived(KINDS.find((k) => k.value === data.kind)?.label ?? 'All');
	let isNavigating = $derived($navigating != null);

	function navigate(params: Record<string, string | null>) {
		const url = new URL($page.url);
		for (const [k, v] of Object.entries(params)) {
			if (v === null || v === undefined) url.searchParams.delete(k);
			else url.searchParams.set(k, v);
		}
		goto(url.pathname + url.search, { invalidateAll: true, replaceState: true });
	}

	function setKind(kind: string | null) {
		navigate({ kind });
	}

	function setState(state: string) {
		navigate({ state });
	}

	function clearRunFilter() {
		navigate({ run: null });
	}

	function clearCampaignFilter() {
		navigate({ campaign: null });
	}

	function toggleCheck(id: number) {
		const next = new Set(checkedIds);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		checkedIds = next;
	}

	async function patchDraft(id: number, body: Record<string, unknown>) {
		const res = await fetch(`/inbox/${id}`, {
			method: 'PATCH',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body),
		});
		if (!res.ok) throw new Error(await res.text());
	}

	async function approveSingle(id: number) {
		try {
			await patchDraft(id, { state: 'approved' });
			toast.success('Approved', { description: 'Open compose to send it.' });
			await invalidateAll();
		} catch (e) {
			toast.error('Action failed', { description: (e as Error).message });
		}
	}

	async function rejectSingle(id: number) {
		try {
			await patchDraft(id, { state: 'rejected' });
			toast.success('Rejected');
			await invalidateAll();
		} catch (e) {
			toast.error('Action failed', { description: (e as Error).message });
		}
	}

	let bulkApproving = $state(false);
	let bulkRejecting = $state(false);

	async function bulkApprove() {
		bulkApproving = true;
		try {
			const ids = [...checkedIds];
			let ok = 0;
			let fail = 0;
			await Promise.all(
				ids.map((id) =>
					patchDraft(id, { state: 'approved' })
						.then(() => ok++)
						.catch(() => fail++)
				)
			);
			toast.success(`${ok} approved${fail > 0 ? `, ${fail} failed` : ''}`);
			checkedIds = new Set();
			await invalidateAll();
		} finally {
			bulkApproving = false;
		}
	}

	async function confirmAndReject() {
		rejectConfirmOpen = true;
		rejectBulk = true;
	}

	async function confirmAndRejectSingle() {
		rejectConfirmOpen = true;
		rejectBulk = false;
	}

	async function doReject() {
		rejectConfirmOpen = false;
		if (rejectBulk) {
			bulkRejecting = true;
			try {
				const ids = [...checkedIds];
				let ok = 0;
				let fail = 0;
				await Promise.all(
					ids.map((id) =>
						patchDraft(id, { state: 'rejected' })
							.then(() => ok++)
							.catch(() => fail++)
					)
				);
				toast.success(`${ok} rejected${fail > 0 ? `, ${fail} failed` : ''}`);
				checkedIds = new Set();
				await invalidateAll();
			} finally {
				bulkRejecting = false;
			}
		} else {
			if (selected) await rejectSingle(selected.id);
		}
	}

	onMount(() => {
		const es = new EventSource('/api/stream');
		es.addEventListener('drafts:changed', () => invalidateAll());
		return () => es.close();
	});

	// Keyboard shortcuts
	onMount(() => {
		function handleKey(e: KeyboardEvent) {
			const target = e.target as HTMLElement;
			if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return;
			switch (e.key) {
				case 'j':
				case 'ArrowDown': {
					e.preventDefault();
					const next = data.drafts[selectedIndex + 1];
					if (next) selectedId = next.id;
					break;
				}
				case 'k':
				case 'ArrowUp': {
					e.preventDefault();
					const prev = data.drafts[selectedIndex - 1];
					if (prev) selectedId = prev.id;
					break;
				}
				case 'a': {
					if (selected?.state === 'pending_review') approveSingle(selected.id);
					break;
				}
				case 'r': {
					if (selected?.state === 'pending_review') confirmAndRejectSingle();
					break;
				}
				case 'e': {
					toast.info('Edit coming soon');
					break;
				}
				case 'o': {
					if (selected?.composeUrl) {
						const sep = selected.composeUrl.includes('?') ? '&' : '?';
						window.open(`${selected.composeUrl}${sep}pitchbox_draft=${selected.id}`, '_blank');
					}
					break;
				}
				case '?': {
					shortcutsOpen = true;
					break;
				}
			}
		}
		window.addEventListener('keydown', handleKey);
		return () => window.removeEventListener('keydown', handleKey);
	});
</script>

<Seo
	title={pendingCount > 0 ? `Inbox (${pendingCount})` : 'Inbox'}
	description="Review and approve drafts generated by campaign runs. Human-in-the-loop outreach."
/>

<PageHeader
	title="Inbox"
	description="Review drafts generated by campaign runs. Approve to unlock the compose URL, reject to dismiss. Nothing is ever sent automatically — every action goes through you."
/>

<!-- Filter pills -->
{#if data.run || data.campaign}
	<div class="flex items-center gap-2 mb-3 flex-wrap">
		{#if data.run && data.runInfo}
			<Badge variant="outline" class="flex items-center gap-1.5 pr-1">
				<span>Run #{data.run}{data.runInfo.campaignName ? ` from ${data.runInfo.campaignName}` : ''}</span>
				<button
					onclick={clearRunFilter}
					class="hover:text-foreground text-muted-foreground ml-0.5"
					aria-label="Clear run filter"
				>
					<X class="size-3" />
				</button>
			</Badge>
		{:else if data.run}
			<Badge variant="outline" class="flex items-center gap-1.5 pr-1">
				<span>Run #{data.run}</span>
				<button onclick={clearRunFilter} class="hover:text-foreground text-muted-foreground ml-0.5" aria-label="Clear run filter">
					<X class="size-3" />
				</button>
			</Badge>
		{/if}
		{#if data.campaign && data.campaignInfo}
			<Badge variant="outline" class="flex items-center gap-1.5 pr-1">
				<span>Campaign: {data.campaignInfo.name}</span>
				<button onclick={clearCampaignFilter} class="hover:text-foreground text-muted-foreground ml-0.5" aria-label="Clear campaign filter">
					<X class="size-3" />
				</button>
			</Badge>
		{:else if data.campaign}
			<Badge variant="outline" class="flex items-center gap-1.5 pr-1">
				<span>Campaign #{data.campaign}</span>
				<button onclick={clearCampaignFilter} class="hover:text-foreground text-muted-foreground ml-0.5" aria-label="Clear campaign filter">
					<X class="size-3" />
				</button>
			</Badge>
		{/if}
	</div>
{/if}

<!-- State tabs + kind filter -->
<div class="mb-3 flex items-center justify-between gap-2 flex-wrap">
	<Tabs.Root
		value={data.state}
		onValueChange={(v) => setState(v)}
		class="w-auto"
	>
		<Tabs.List>
			{#each STATES as s (s.value)}
				<Tabs.Trigger value={s.value}>{s.label}</Tabs.Trigger>
			{/each}
		</Tabs.List>
	</Tabs.Root>

	<div class="flex items-center gap-2">
		<DropdownMenu.Root>
			<DropdownMenu.Trigger>
				{#snippet child({ props })}
					<Button {...props} variant="outline" size="sm">
						Kind: {kindLabel}
						<ChevronDown class="ml-1 size-3" />
					</Button>
				{/snippet}
			</DropdownMenu.Trigger>
			<DropdownMenu.Content align="end">
				{#each KINDS as k (k.label)}
					<DropdownMenu.Item onclick={() => setKind(k.value)}>
						{k.label}
					</DropdownMenu.Item>
				{/each}
			</DropdownMenu.Content>
		</DropdownMenu.Root>

		<Button
			variant="ghost"
			size="sm"
			onclick={() => (shortcutsOpen = true)}
			aria-label="Show keyboard shortcuts"
		>
			<Keyboard class="size-4" />
		</Button>
	</div>
</div>

<Card.Root class="grid grid-cols-[360px_1fr] h-[calc(100vh-11rem)] overflow-hidden">
	<aside class="border-r border-border overflow-auto relative">
		{#if isNavigating}
			<div class="p-3 space-y-2">
				{#each Array(6) as _, i (i)}
					<Skeleton class="h-16 w-full rounded" />
				{/each}
			</div>
		{:else if data.drafts.length === 0}
			<div class="flex flex-col items-center justify-center h-full gap-3 p-6 text-center">
				<Inbox class="size-10 text-muted-foreground/40" />
				<div>
					<p class="text-sm font-medium">No drafts yet</p>
					<p class="text-xs text-muted-foreground mt-0.5">
						Drafts will appear here when a campaign runs.
					</p>
				</div>
				<Button variant="outline" size="sm" href="/campaigns">Go to Campaigns</Button>
			</div>
		{:else}
			{#each data.drafts as draft (draft.id)}
				{@const isSelected = draft.id === selectedId}
				{@const isChecked = checkedIds.has(draft.id)}
				<div
					class="flex items-stretch group relative transition-colors {isSelected
						? 'bg-accent/60'
						: 'hover:bg-accent/30'}"
				>
					<!-- Accent bar for selected row -->
					<span
						aria-hidden="true"
						class="absolute inset-y-0 left-0 w-[3px] transition-colors {isSelected
							? 'bg-primary'
							: 'bg-transparent'}"
					></span>
					<div
						class="flex items-center pl-3 pr-2 cursor-pointer"
						onclick={(e) => e.stopPropagation()}
						onkeydown={(e) => {
							if (e.key === ' ' || e.key === 'Enter') {
								e.stopPropagation();
							}
						}}
						role="presentation"
					>
						<Checkbox
							checked={isChecked}
							onCheckedChange={() => toggleCheck(draft.id)}
							aria-label="Select draft {draft.id}"
						/>
					</div>
					<div class="flex-1 min-w-0">
						<DraftListItem
							{draft}
							selected={isSelected}
							runId={draft.runId}
							onclick={() => (selectedId = draft.id)}
							usage={data.usage[draft.accountId]}
							limits={data.quotaLimits}
						/>
					</div>
				</div>
			{/each}
		{/if}
	</aside>
	<section class="p-4 overflow-auto">
		<DraftDetail
			draft={selected}
			usage={selected != null ? data.usage[selected.accountId] : undefined}
			limits={data.quotaLimits}
		/>
	</section>
</Card.Root>

<!-- Bulk action floating bar -->
{#if checkedIds.size > 0}
	<div
		class="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 bg-popover border border-border rounded-xl shadow-lg px-4 py-2.5 text-sm"
	>
		<span class="text-muted-foreground font-medium">{checkedIds.size} selected</span>
		<div class="w-px h-4 bg-border"></div>
		<Button size="sm" variant="default" loading={bulkApproving} onclick={bulkApprove}>
			Approve all
		</Button>
		<Button size="sm" variant="destructive" loading={bulkRejecting} onclick={confirmAndReject}>
			Reject all
		</Button>
		<Button
			size="sm"
			variant="ghost"
			onclick={() => (checkedIds = new Set())}
			aria-label="Cancel selection"
		>
			<X class="size-4" />
			Cancel
		</Button>
	</div>
{/if}

<!-- Reject confirmation dialog -->
<AlertDialog.Root bind:open={rejectConfirmOpen}>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>Confirm rejection</AlertDialog.Title>
			<AlertDialog.Description>
				{#if rejectBulk}
					Reject {checkedIds.size} selected draft{checkedIds.size === 1 ? '' : 's'}? This cannot be undone.
				{:else}
					Reject this draft? This cannot be undone.
				{/if}
			</AlertDialog.Description>
		</AlertDialog.Header>
		<AlertDialog.Footer>
			<AlertDialog.Cancel onclick={() => (rejectConfirmOpen = false)}>Cancel</AlertDialog.Cancel>
			<AlertDialog.Action onclick={doReject} variant="destructive">Reject</AlertDialog.Action>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>

<!-- Keyboard shortcuts dialog -->
<Dialog.Root bind:open={shortcutsOpen}>
	<Dialog.Content>
		<Dialog.Header>
			<Dialog.Title>Keyboard shortcuts</Dialog.Title>
			<Dialog.Description>Available in the inbox when not focused on an input.</Dialog.Description>
		</Dialog.Header>
		<div class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm mt-2">
			{#each [
				['j / ↓', 'Next draft'],
				['k / ↑', 'Previous draft'],
				['a', 'Approve current draft'],
				['r', 'Reject current draft (confirm)'],
				['e', 'Edit draft (coming soon)'],
				['o', 'Open compose URL'],
				['?', 'Show this dialog'],
			] as [key, desc] (key)}
				<kbd class="font-mono text-xs bg-muted px-1.5 py-0.5 rounded border border-border self-center w-fit">{key}</kbd>
				<span class="text-muted-foreground">{desc}</span>
			{/each}
		</div>
	</Dialog.Content>
</Dialog.Root>
