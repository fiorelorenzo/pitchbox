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
		Globe,
		Bell,
		History,
		BarChart3,
		BrainCircuit,
		LogOut,
		type LucideIcon,
	} from '@lucide/svelte';
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { cn } from '$lib/utils';
	import { toast } from 'svelte-sonner';
	import SystemStatusCard from '$lib/components/SystemStatusCard.svelte';
	import OrgSwitcher from '$lib/components/OrgSwitcher.svelte';
	import { resolveTone, PULSE_DOT_CLASS } from '$lib/config/status-badges';
	import { DOCS_URL } from '$lib/config/docs';
	import { t, type Locale } from '$lib/i18n/index.js';

	// The marketing site (#429): the app moved off the apex to app.pitchbox.app
	// (#422/#424), so nothing here pointed back at it until now.
	const WEBSITE_URL = 'https://pitchbox.app';

	const locale = $derived($page.data.locale as Locale);

	type NavItem = {
		href: string;
		label: string;
		icon: LucideIcon;
		exact?: boolean;
		show?: boolean;
	};

	type NavGroup = {
		// Group label, or null for the loose top/bottom items that sit
		// outside the four labelled sections.
		label: string | null;
		items: NavItem[];
	};

	// Surfaced by web/src/routes/+layout.server.ts; defaults true so nothing
	// hides before the loader has run, same convention `authOn` below uses.
	const isAdmin = $derived(($page.data?.isAdmin ?? true) as boolean);

	// Grouped per the UX review (#251): Home and Inbox stay loose above the
	// groups as the daily pair, Notifications and Settings stay loose below.
	// PEOPLE held Conversations + Contacts + Blocklist; #252 merged
	// Conversations and Contacts into the single /people destination, so the
	// group is now People + Blocklist. LOR-178/179 added a fourth labelled
	// group, Assistant: the companion's own top-level route, split out of
	// settings/companion into /companion, /companion/voice and
	// /companion/work (each sub-route gates itself, see
	// web/src/routes/companion/+page.server.ts), deliberately its own group
	// rather than folded into Insight (it is not a report) or People (it is
	// not a contact) - the assist plane is expected to grow more surfaces
	// next to it. Hidden from a member the same way the settings rail hid
	// the same route (docs/permissions.md "## UI"): the loader throws
	// requireRole('admin'), so a visible link would only ever 403. Nothing
	// here assumes a fixed item count per group; a group left with no items
	// after the `show` filter below is dropped rather than rendering an
	// empty label.
	const navGroups = $derived(
		(
			[
				{
					label: null,
					items: [
						{ href: '/', label: t(locale, 'nav.home'), icon: Home, exact: true },
						{ href: '/inbox', label: t(locale, 'nav.inbox'), icon: Inbox },
					],
				},
				{
					label: t(locale, 'nav.group-outreach'),
					items: [
						{ href: '/projects', label: t(locale, 'nav.projects'), icon: FolderKanban },
						{ href: '/campaigns', label: t(locale, 'nav.campaigns'), icon: PlayCircle },
						{ href: '/playbooks', label: t(locale, 'nav.playbooks'), icon: BookOpen },
					],
				},
				{
					label: t(locale, 'nav.group-people'),
					items: [
						{ href: '/people', label: t(locale, 'nav.people'), icon: Users },
						{ href: '/blocklist', label: t(locale, 'nav.blocklist'), icon: Shield },
					],
				},
				{
					label: t(locale, 'nav.group-insight'),
					items: [
						{ href: '/analytics', label: t(locale, 'nav.analytics'), icon: BarChart3 },
						{ href: '/audit', label: t(locale, 'nav.audit'), icon: History },
					],
				},
				{
					label: t(locale, 'nav.group-assistant'),
					items: [
						{
							href: '/companion',
							label: t(locale, 'nav.companion'),
							icon: BrainCircuit,
							show: isAdmin,
						},
					],
				},
				{
					label: null,
					items: [
						{ href: '/notifications', label: t(locale, 'nav.notifications'), icon: Bell },
						{ href: '/settings', label: t(locale, 'nav.settings'), icon: Settings },
					],
				},
			] as NavGroup[]
		)
			.map((group) => ({ ...group, items: group.items.filter((item) => item.show ?? true) }))
			.filter((group) => group.items.length > 0),
	);

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
				// A 401 here means the session lapsed while the page stayed open, not
				// a failure the user can act on: the next navigation lands on /login.
				// Never surface the API's own error string either - it reaches the
				// user as raw wire text ("unauthenticated") instead of a sentence.
				if (!unreadStale && res.status !== 401) toast.error(t(locale, 'nav.error-refresh-count'));
				unreadStale = true;
				return;
			}
			const body = await res.json();
			unread = body.unread ?? 0;
			unreadStale = false;
		} catch {
			if (!unreadStale) toast.error(t(locale, 'nav.error-refresh-count-offline'));
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

<aside
	aria-label={t(locale, 'nav.aria-primary')}
	class="w-60 h-full bg-background border-r border-border flex flex-col p-4 overflow-hidden min-h-0"
>
	<!-- Brand -->
	<div class="flex items-center gap-2 mb-6">
		<img src="/favicon.svg" alt="" class="size-7 shrink-0" aria-hidden="true" />
		<h1 class="font-semibold text-lg">{t(locale, 'brand.name')}</h1>
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
						title={t(locale, 'nav.error-refresh-count')}
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

	<!-- Bottom section: website + docs + auth + system status -->
	<div class="flex flex-col gap-1 border-t border-border mt-4 pt-4">
		<a
			href={WEBSITE_URL}
			target="_blank"
			rel="noopener"
			class="flex items-center gap-2 px-3 py-2 rounded-md text-sm text-muted-foreground hover:bg-accent/50 hover:text-foreground transition-colors"
		>
			<Globe class="size-4 shrink-0" />
			{t(locale, 'nav.website')}
		</a>
		<a
			href={DOCS_URL}
			target="_blank"
			rel="noopener"
			class="flex items-center gap-2 px-3 py-2 rounded-md text-sm text-muted-foreground hover:bg-accent/50 hover:text-foreground transition-colors"
		>
			<BookOpen class="size-4 shrink-0" />
			{t(locale, 'nav.docs')}
		</a>
		{#if authOn}
			<button
				type="button"
				onclick={async () => {
					try {
						const res = await fetch('/api/auth/logout', { method: 'POST' });
						if (!res.ok) {
						toast.error(t(locale, 'nav.error-sign-out'));
							return;
						}
						await goto('/login');
					} catch {
					toast.error(t(locale, 'nav.error-sign-out-offline'));
					}
				}}
				class="flex items-center gap-2 px-3 py-2 rounded-md text-sm text-muted-foreground hover:bg-accent/50 hover:text-foreground transition-colors text-left"
			>
				<LogOut class="size-4 shrink-0" />
				{t(locale, 'nav.sign-out')}
			</button>
		{/if}
		<div class="px-1 pt-1">
			<SystemStatusCard />
		</div>
	</div>
</aside>
