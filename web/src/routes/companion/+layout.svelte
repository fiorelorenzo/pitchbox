<script lang="ts">
	import type { Snippet } from 'svelte';
	import { page } from '$app/stores';
	import { UserRound, Mic, FolderGit2, type LucideIcon } from '@lucide/svelte';

	let { children }: { children: Snippet } = $props();

	type Item = { href: string; label: string; icon: LucideIcon; exact?: boolean };

	// The companion area (LOR-178/LOR-179, docs/design/DECISIONS.md D35): its
	// own top-level sidebar group, split into three routes that each gate
	// themselves in their own +page.server.ts (see companion/+page.server.ts's
	// comment). This layout deliberately carries no +layout.server.ts and
	// therefore no gate of its own - a gate here would be exactly the kind of
	// inherited, easy-to-forget check the split was meant to avoid. The nav
	// below is presentation only, same link styling the settings rail uses
	// (web/src/routes/settings/+layout.svelte, docs/permissions.md "## UI").
	const items: Item[] = [
		{ href: '/companion', label: 'Persona', icon: UserRound, exact: true },
		{ href: '/companion/voice', label: 'Voice', icon: Mic },
		{ href: '/companion/work', label: 'Work', icon: FolderGit2 },
	];

	function isActive(item: Item): boolean {
		return item.exact
			? $page.url.pathname === item.href
			: $page.url.pathname.startsWith(item.href);
	}
</script>

<nav class="mb-4 flex flex-wrap gap-1 border-b border-border pb-2" aria-label="Companion sections">
	{#each items as item (item.href)}
		{@const Icon = item.icon}
		<a
			href={item.href}
			aria-current={isActive(item) ? 'page' : undefined}
			class={`flex items-center gap-2 rounded-md px-3 py-1.5 text-sm transition-colors ${
				isActive(item)
					? 'bg-accent font-medium text-foreground'
					: 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
			}`}
		>
			<Icon class="size-4" />
			{item.label}
		</a>
	{/each}
</nav>

{@render children()}
