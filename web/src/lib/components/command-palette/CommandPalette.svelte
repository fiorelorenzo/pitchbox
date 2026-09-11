<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import * as Command from '$lib/components/ui/command/index.js';
	import { FileText, Users, Megaphone, FolderOpen, Plus, Key, Settings } from '@lucide/svelte';
	import { t, type Locale } from '$lib/i18n/index.js';

	type SearchResult = {
		kind: 'draft' | 'contact' | 'campaign' | 'project';
		id: number | string;
		label: string;
		sublabel?: string;
		href: string;
	};

	const locale = $derived($page.data.locale as Locale);

	let open = $state(false);
	let query = $state('');
	let results = $state<SearchResult[]>([]);
	let loading = $state(false);
	let searchError = $state<string | null>(null);
	let debounceTimer: ReturnType<typeof setTimeout> | null = null;

	// Static fallback actions shown when the query is empty.
	const staticActions = $derived([
		{ label: t(locale, 'command-palette.action-create-campaign'), href: '/campaigns/new', icon: Plus },
		{
			label: t(locale, 'command-palette.action-generate-token'),
			href: '/settings/extension',
			icon: Key,
		},
		{ label: t(locale, 'command-palette.action-open-settings'), href: '/settings', icon: Settings },
	]);

	function onKeydown(e: KeyboardEvent) {
		// Toggle on Cmd+K (mac) or Ctrl+K (others).
		if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
			e.preventDefault();
			open = !open;
		}
	}

	onMount(() => {
		window.addEventListener('keydown', onKeydown);
		return () => window.removeEventListener('keydown', onKeydown);
	});

	async function runSearch(q: string) {
		if (!q.trim()) {
			results = [];
			searchError = null;
			loading = false;
			return;
		}
		loading = true;
		searchError = null;
		try {
			const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
			if (!res.ok) {
				const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
				if (res.status >= 500) {
					console.error('search failed', res.status, body);
					searchError = t(locale, 'command-palette.error-unavailable');
				} else {
					searchError = body.error ?? body.message ?? t(locale, 'command-palette.error-rejected');
				}
				results = [];
				return;
			}
			const data = (await res.json()) as { results: SearchResult[] };
			results = data.results ?? [];
		} catch {
			searchError = t(locale, 'command-palette.error-unavailable-offline');
			results = [];
		} finally {
			loading = false;
		}
	}

	$effect(() => {
		const q = query;
		if (debounceTimer) clearTimeout(debounceTimer);
		debounceTimer = setTimeout(() => void runSearch(q), 150);
	});

	function pick(href: string) {
		open = false;
		query = '';
		results = [];
		void goto(href);
	}

	const grouped = $derived.by(() => {
		const groups: Record<SearchResult['kind'], SearchResult[]> = {
			draft: [],
			contact: [],
			campaign: [],
			project: [],
		};
		for (const r of results) groups[r.kind].push(r);
		return groups;
	});
</script>

<Command.Dialog bind:open shouldFilter={false}>
	<Command.Input placeholder={t(locale, 'command-palette.placeholder')} bind:value={query} />
	<Command.List>
		{#if !query.trim()}
			<Command.Group heading={t(locale, 'command-palette.heading-actions')}>
				{#each staticActions as action (action.href + action.label)}
					{@const Icon = action.icon}
					<Command.Item onSelect={() => pick(action.href)}>
						<Icon class="size-4" />
						<span>{action.label}</span>
					</Command.Item>
				{/each}
			</Command.Group>
		{:else if loading && results.length === 0}
			<Command.Loading>{t(locale, 'command-palette.searching')}</Command.Loading>
		{:else if searchError}
			<Command.Empty>{searchError}</Command.Empty>
		{:else if results.length === 0}
			<Command.Empty>{t(locale, 'command-palette.no-results')}</Command.Empty>
		{:else}
			{#if grouped.draft.length > 0}
				<Command.Group heading={t(locale, 'command-palette.heading-drafts')}>
					{#each grouped.draft as r (r.id)}
						<Command.Item onSelect={() => pick(r.href)}>
							<FileText class="size-4" />
							<div class="flex flex-col">
								<span>{r.label}</span>
								{#if r.sublabel}
									<span class="text-xs text-muted-foreground truncate">{r.sublabel}</span>
								{/if}
							</div>
						</Command.Item>
					{/each}
				</Command.Group>
			{/if}
			{#if grouped.contact.length > 0}
				<Command.Group heading={t(locale, 'command-palette.heading-contacts')}>
					{#each grouped.contact as r (r.id)}
						<Command.Item onSelect={() => pick(r.href)}>
							<Users class="size-4" />
							<div class="flex flex-col">
								<span>{r.label}</span>
								{#if r.sublabel}
									<span class="text-xs text-muted-foreground">{r.sublabel}</span>
								{/if}
							</div>
						</Command.Item>
					{/each}
				</Command.Group>
			{/if}
			{#if grouped.campaign.length > 0}
				<Command.Group heading={t(locale, 'command-palette.heading-campaigns')}>
					{#each grouped.campaign as r (r.id)}
						<Command.Item onSelect={() => pick(r.href)}>
							<Megaphone class="size-4" />
							<span>{r.label}</span>
						</Command.Item>
					{/each}
				</Command.Group>
			{/if}
			{#if grouped.project.length > 0}
				<Command.Group heading={t(locale, 'command-palette.heading-projects')}>
					{#each grouped.project as r (r.id)}
						<Command.Item onSelect={() => pick(r.href)}>
							<FolderOpen class="size-4" />
							<div class="flex flex-col">
								<span>{r.label}</span>
								{#if r.sublabel}
									<span class="text-xs text-muted-foreground">{r.sublabel}</span>
								{/if}
							</div>
						</Command.Item>
					{/each}
				</Command.Group>
			{/if}
		{/if}
	</Command.List>
</Command.Dialog>

