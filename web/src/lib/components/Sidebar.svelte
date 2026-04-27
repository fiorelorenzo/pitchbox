<script lang="ts">
	import { page } from '$app/stores';
	import {
		Home,
		Inbox,
		PlayCircle,
		Users,
		MessagesSquare,
		Shield,
		Settings,
		BookOpen,
		type Icon as LucideIcon,
	} from 'lucide-svelte';
	import { cn } from '$lib/utils';
	import { VERSION } from '$lib/shared/version';
	import { daemonStatus } from '$lib/stores/daemon';
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
		{ href: '/campaigns', label: 'Campaigns', icon: PlayCircle },
		{ href: '/contacts', label: 'Contacts', icon: Users },
		{ href: '/conversations', label: 'Conversations', icon: MessagesSquare },
		{ href: '/blocklist', label: 'Blocklist', icon: Shield },
		{ href: '/settings', label: 'Settings', icon: Settings },
	];
</script>

<aside class="w-60 border-r border-border flex flex-col p-4">
	<!-- Brand -->
	<h1 class="font-semibold text-lg mb-6">Pitchbox</h1>

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
				{item.label}
			</a>
		{/each}
	</nav>

	<!-- Bottom section: docs + version -->
	<div class="flex flex-col gap-1 border-t border-border mt-4 pt-4">
		<a
			href="/README.md"
			target="_blank"
			rel="noopener"
			class="flex items-center gap-2 px-3 py-2 rounded-md text-sm text-muted-foreground hover:bg-accent/50 hover:text-foreground transition-colors"
		>
			<BookOpen class="size-4 shrink-0" />
			Docs
		</a>
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
