<script lang="ts">
	import { page } from '$app/stores';
	import {
		Home,
		Inbox,
		FolderKanban,
		PlayCircle,
		Users,
		Shield,
		Settings,
		BookOpen,
		Bell,
		History,
		BarChart3,
		LogOut,
		type LucideIcon,
	} from '@lucide/svelte';
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { dev } from '$app/environment';
	import { cn } from '$lib/utils';
	import { toast } from 'svelte-sonner';
	import SystemStatusCard from '$lib/components/SystemStatusCard.svelte';
	import OrgSwitcher from '$lib/components/OrgSwitcher.svelte';
	import { resolveTone, PULSE_DOT_CLASS } from '$lib/config/status-badges';

	// VitePress dev server runs on :5181 with base /pitchbox/. In production
	// the published Pages site is the source of truth.
	const DOCS_URL = dev ? 'http://localhost:5181/pitchbox/' : 'https://fiorelorenzo.github.io/pitchbox/';

	type NavItem = {
		href: string;
		label: string;
		icon: LucideIcon;
		exact?: boolean;
	};

	type NavGroup = {
		// Group label, or null for the loose top/bottom items that sit
		// outside the three labelled sections.
		label: string | null;
		items: NavItem[];
	};

	// Grouped per the UX review (#251): Home and Inbox stay loose above the
	// groups as the daily pair, Notifications and Settings stay loose below.
	// PEOPLE held Conversations + Contacts + Blocklist; #252 merged
	// Conversations and Contacts into the single /people destination, so the
	// group is now People + Blocklist. Nothing here assumes a fixed item
	// count per group.
	const navGroups: NavGroup[] = [
		{
			label: null,
			items: [
				{ href: '/', label: 'Home', icon: Home, exact: true },
				{ href: '/inbox', label: 'Inbox', icon: Inbox },
			],
		},
		{
			label: 'Outreach',
			items: [
				{ href: '/projects', label: 'Projects', icon: FolderKanban },
				{ href: '/campaigns', label: 'Campaigns', icon: PlayCircle },
				{ href: '/playbooks', label: 'Playbooks', icon: BookOpen },
			],
		},
		{
			label: 'People',
			items: [
				{ href: '/people', label: 'People', icon: Users },
				{ href: '/blocklist', label: 'Blocklist', icon: Shield },
			],
		},
		{
			label: 'Insight',
			items: [
				{ href: '/analytics', label: 'Analytics', icon: BarChart3 },
				{ href: '/audit', label: 'Audit', icon: History },
			],
		},
		{
			label: null,
			items: [
				{ href: '/notifications', label: 'Notifications', icon: Bell },
				{ href: '/settings', label: 'Settings', icon: Settings },
			],
		},
	];

	let unread = $state(0);
	// Set once a poll fails and cleared on the next success, so the badge can
	// show a "stale" dot instead of quietly freezing on the last-known count.
	let unreadStale = $state(false);

	async function refreshUnread() {
		try {
			const res = await fetch('/api/notifications');
			if (!res.ok) {
				const body = await res.json().catch(() => ({}));
				if (res.status >= 500) console.error('failed to refresh notification count', res.status, body);
				// Toast only on the transition into failure, not on every 30s poll.
				if (!unreadStale) toast.error(body.error ?? 'Could not refresh notification count');
				unreadStale = true;
				return;
			}
			const body = await res.json();
			unread = body.unread ?? 0;
			unreadStale = false;
		} catch {
			if (!unreadStale) toast.error('Could not refresh notification count, check your connection');
			unreadStale = true;
		}
	}

	onMount(() => {
		refreshUnread();
		const id = setInterval(refreshUnread, 30_000);
		return () => clearInterval(id);
	});

	$effect(() => {
		// re-poll whenever the active route changes
		void $page.url.pathname;
		refreshUnread();
	});

	// Surfaced by web/src/routes/+layout.server.ts; falls back to `true` so
	// nothing breaks if the loader hasn't run yet.
	const authOn = $derived(($page.data?.authOn ?? true) as boolean);

	// Organization switcher: only meaningful when auth is on and the caller
	// has at least one membership (both surfaced by the root layout loader).
	type OrgSummary = { id: number; slug: string; name: string; role: string };
	const orgs = $derived(($page.data?.orgs ?? []) as OrgSummary[]);
	const activeOrgId = $derived(($page.data?.org as { id: number } | undefined)?.id);
</script>

<aside class="w-60 h-full bg-background border-r border-border flex flex-col p-4 overflow-hidden min-h-0">
	<!-- Brand -->
	<div class="flex items-center gap-2 mb-6">
		<img src="/favicon.svg" alt="" class="size-7 shrink-0" aria-hidden="true" />
		<h1 class="font-semibold text-lg">Pitchbox</h1>
	</div>

	<!-- Organization switcher: shown only when auth is on and the caller has
	     at least one membership. -->
	{#if authOn && orgs.length > 0}
		<div class="mb-4">
			<OrgSwitcher {orgs} {activeOrgId} />
		</div>
	{/if}

	<!-- Nav links. min-h-0 lets nav shrink under flex pressure so the footer
	     status card always stays visible; only the nav itself can scroll if a
	     viewport is too short for all entries. -->
	<nav class="flex flex-col gap-1 flex-1 min-h-0 overflow-y-auto">
		{#each navGroups as group, groupIndex (groupIndex)}
			{#if group.label}
				<p class="px-3 pt-3 pb-1 text-xs uppercase text-muted-foreground">
					{group.label}
				</p>
			{:else if groupIndex > 0}
				<div class="my-2 border-t border-border"></div>
			{/if}
			{#each group.items as item (item.href)}
				{@const active = item.exact
					? $page.url.pathname === item.href
					: $page.url.pathname.startsWith(item.href) ||
						(item.href === '/people' && $page.url.pathname.startsWith('/conversations/'))}
				{@const Icon = item.icon}
				<a
					href={item.href}
					class={cn(
						'flex items-center gap-2 px-3 py-2 rounded-md text-sm transition-colors',
						active
							? 'bg-accent text-accent-foreground font-medium'
							: 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
					)}
				>
					<Icon class="size-4 shrink-0" />
					<span class="flex-1">{item.label}</span>
					{#if item.href === '/notifications' && unreadStale}
						<span
							title="Could not refresh notification count"
							class="size-1.5 rounded-full shrink-0 {PULSE_DOT_CLASS[resolveTone('connection-status', 'down')]}"
						></span>
					{:else if item.href === '/notifications' && unread > 0}
						<span class="rounded-full bg-sky-500/20 px-1.5 py-0.5 text-[10px] font-semibold text-sky-700 dark:text-sky-300">
							{unread > 99 ? '99+' : unread}
						</span>
					{/if}
				</a>
			{/each}
		{/each}
	</nav>

	<!-- Bottom section: docs + auth + system status -->
	<div class="flex flex-col gap-1 border-t border-border mt-4 pt-4">
		<a
			href={DOCS_URL}
			target="_blank"
			rel="noopener"
			class="flex items-center gap-2 px-3 py-2 rounded-md text-sm text-muted-foreground hover:bg-accent/50 hover:text-foreground transition-colors"
		>
			<BookOpen class="size-4 shrink-0" />
			Docs
		</a>
		{#if authOn}
			<button
				type="button"
				onclick={async () => {
					try {
						const res = await fetch('/api/auth/logout', { method: 'POST' });
						if (!res.ok) {
							toast.error('Could not sign out. Please try again.');
							return;
						}
						await goto('/login');
					} catch {
						toast.error('Could not sign out, check your connection.');
					}
				}}
				class="flex items-center gap-2 px-3 py-2 rounded-md text-sm text-muted-foreground hover:bg-accent/50 hover:text-foreground transition-colors text-left"
			>
				<LogOut class="size-4 shrink-0" />
				Sign out
			</button>
		{/if}
		<div class="px-1 pt-1">
			<SystemStatusCard />
		</div>
	</div>
</aside>
