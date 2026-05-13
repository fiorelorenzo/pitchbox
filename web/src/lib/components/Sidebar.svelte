<script lang="ts">
	import { page } from '$app/stores';
	import {
		Home,
		Inbox,
		FolderKanban,
		PlayCircle,
		Users,
		MessagesSquare,
		Shield,
		Settings,
		BookOpen,
		Bell,
		History,
		BarChart3,
		LogOut,
		LogIn,
		type Icon as LucideIcon,
	} from 'lucide-svelte';
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { cn } from '$lib/utils';
	import SystemStatusCard from '$lib/components/SystemStatusCard.svelte';
	import { t } from '$lib/i18n';
	import type { ComponentType } from 'svelte';

	type NavItem = {
		href: string;
		labelKey: string;
		icon: ComponentType<LucideIcon>;
		exact?: boolean;
	};

	const navItems: NavItem[] = [
		{ href: '/', labelKey: 'nav.home', icon: Home, exact: true },
		{ href: '/inbox', labelKey: 'nav.inbox', icon: Inbox },
		{ href: '/projects', labelKey: 'nav.projects', icon: FolderKanban },
		{ href: '/campaigns', labelKey: 'nav.campaigns', icon: PlayCircle },
		{ href: '/contacts', labelKey: 'nav.contacts', icon: Users },
		{ href: '/conversations', labelKey: 'nav.conversations', icon: MessagesSquare },
		{ href: '/blocklist', labelKey: 'nav.blocklist', icon: Shield },
		{ href: '/playbooks', labelKey: 'nav.playbooks', icon: BookOpen },
		{ href: '/notifications', labelKey: 'nav.notifications', icon: Bell },
		{ href: '/analytics', labelKey: 'nav.analytics', icon: BarChart3 },
		{ href: '/audit', labelKey: 'nav.audit', icon: History },
		{ href: '/settings', labelKey: 'nav.settings', icon: Settings },
	];

	let unread = $state(0);

	async function refreshUnread() {
		try {
			const res = await fetch('/api/notifications');
			if (!res.ok) return;
			const body = await res.json();
			unread = body.unread ?? 0;
		} catch {
			// network errors are non-fatal for the bell badge.
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
</script>

<aside class="w-60 h-full bg-background border-r border-border flex flex-col p-4 overflow-hidden">
	<!-- Brand -->
	<div class="flex items-center gap-2 mb-6">
		<img src="/favicon.svg" alt="" class="size-7 shrink-0" aria-hidden="true" />
		<h1 class="font-semibold text-lg">Pitchbox</h1>
	</div>

	<!-- Nav links -->
	<nav class="flex flex-col gap-1 flex-1">
		{#each navItems as item (item.href)}
			{@const active = item.exact
				? $page.url.pathname === item.href
				: $page.url.pathname.startsWith(item.href)}
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
				<span class="flex-1">{$t(item.labelKey)}</span>
				{#if item.href === '/notifications' && unread > 0}
					<span class="rounded-full bg-sky-500/20 px-1.5 py-0.5 text-[10px] font-semibold text-sky-700 dark:text-sky-300">
						{unread > 99 ? '99+' : unread}
					</span>
				{/if}
			</a>
		{/each}
	</nav>

	<!-- Bottom section: docs + auth + system status -->
	<div class="flex flex-col gap-1 border-t border-border mt-4 pt-4">
		<a
			href="https://github.com/fiorelorenzo/pitchbox#readme"
			target="_blank"
			rel="noopener"
			class="flex items-center gap-2 px-3 py-2 rounded-md text-sm text-muted-foreground hover:bg-accent/50 hover:text-foreground transition-colors"
		>
			<BookOpen class="size-4 shrink-0" />
			{$t('nav.docs')}
		</a>
		{#if authOn}
			<button
				type="button"
				onclick={async () => {
					await fetch('/api/auth/logout', { method: 'POST' });
					await goto('/login');
				}}
				class="flex items-center gap-2 px-3 py-2 rounded-md text-sm text-muted-foreground hover:bg-accent/50 hover:text-foreground transition-colors text-left"
			>
				<LogOut class="size-4 shrink-0" />
				{$t('nav.signOut')}
			</button>
		{:else}
			<a
				href="/login"
				class="flex items-center gap-2 px-3 py-2 rounded-md text-sm text-muted-foreground hover:bg-accent/50 hover:text-foreground transition-colors"
			>
				<LogIn class="size-4 shrink-0" />
				{$t('nav.signIn')}
			</a>
		{/if}
		<div class="px-1 pt-1">
			<SystemStatusCard />
		</div>
	</div>
</aside>
