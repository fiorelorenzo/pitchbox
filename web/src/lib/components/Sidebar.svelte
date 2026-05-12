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
		LogOut,
		type Icon as LucideIcon,
	} from 'lucide-svelte';
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { cn } from '$lib/utils';
	import { VERSION } from '$lib/shared/version';
	import { daemonStatus } from '$lib/stores/daemon';
	import ThemeToggle from '$lib/components/ThemeToggle.svelte';
	import type { ComponentType } from 'svelte';

	type NavItem = {
		href: string;
		label: string;
		icon: ComponentType<LucideIcon>;
		exact?: boolean;
	};

	const navItems: NavItem[] = [
		{ href: '/', label: 'Home', icon: Home, exact: true },
		{ href: '/inbox', label: 'Inbox', icon: Inbox },
		{ href: '/projects', label: 'Projects', icon: FolderKanban },
		{ href: '/campaigns', label: 'Campaigns', icon: PlayCircle },
		{ href: '/contacts', label: 'Contacts', icon: Users },
		{ href: '/conversations', label: 'Conversations', icon: MessagesSquare },
		{ href: '/blocklist', label: 'Blocklist', icon: Shield },
		{ href: '/playbooks', label: 'Playbooks', icon: BookOpen },
		{ href: '/notifications', label: 'Notifications', icon: Bell },
		{ href: '/settings', label: 'Settings', icon: Settings },
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
</script>

<aside class="w-60 border-r border-border flex flex-col p-4">
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
				<span class="flex-1">{item.label}</span>
				{#if item.href === '/notifications' && unread > 0}
					<span class="rounded-full bg-sky-500/20 px-1.5 py-0.5 text-[10px] font-semibold text-sky-700 dark:text-sky-300">
						{unread > 99 ? '99+' : unread}
					</span>
				{/if}
			</a>
		{/each}
	</nav>

	<!-- Bottom section: theme + docs + version -->
	<div class="flex flex-col gap-1 border-t border-border mt-4 pt-4">
		<div class="px-1 pb-1">
			<ThemeToggle />
		</div>
		<a
			href="/README.md"
			target="_blank"
			rel="noopener"
			class="flex items-center gap-2 px-3 py-2 rounded-md text-sm text-muted-foreground hover:bg-accent/50 hover:text-foreground transition-colors"
		>
			<BookOpen class="size-4 shrink-0" />
			Docs
		</a>
		<button
			type="button"
			onclick={async () => {
				await fetch('/api/auth/logout', { method: 'POST' });
				await goto('/login');
			}}
			class="flex items-center gap-2 px-3 py-2 rounded-md text-sm text-muted-foreground hover:bg-accent/50 hover:text-foreground transition-colors text-left"
		>
			<LogOut class="size-4 shrink-0" />
			Sign out
		</button>
		<div class="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
			<span
				class="size-2 rounded-full shrink-0 {$daemonStatus.loading
					? 'bg-muted-foreground/40'
					: $daemonStatus.alive
						? 'bg-emerald-400 animate-pulse'
						: 'bg-muted-foreground/40'}"
			></span>
			<span>
				Daemon:
				{#if $daemonStatus.loading}
					…
				{:else if $daemonStatus.alive}
					online
				{:else}
					offline
				{/if}
			</span>
			<span class="ml-auto font-mono opacity-50">{VERSION}</span>
		</div>
	</div>
</aside>
