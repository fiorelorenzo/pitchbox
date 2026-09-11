<script lang="ts">
	import type { Snippet } from 'svelte';
	import { page } from '$app/stores';
	import { IdCard, AudioLines, Briefcase, type LucideIcon } from '@lucide/svelte';
	import { t, type Locale } from '$lib/i18n/index.js';

	let { children }: { children: Snippet } = $props();

	const locale = $derived($page.data.locale as Locale);

	type Item = { href: string; labelKey: string; icon: LucideIcon; exact?: boolean };

	// The companion area (LOR-178/LOR-179, docs/design/DECISIONS.md D35): its
	// own top-level sidebar group, split into three routes that each gate
	// themselves in their own +page.server.ts (see companion/+page.server.ts's
	// comment). This layout deliberately carries no +layout.server.ts and
	// therefore no gate of its own - a gate here would be exactly the kind of
	// inherited, easy-to-forget check the split was meant to avoid.
	//
	// LOR-207: the nav is the same vertical rail settings uses
	// (web/src/routes/settings/+layout.svelte), not a second navigation idiom.
	// Below md it is a wrapping horizontal strip for the same reason the
	// settings one wraps: three entries must all stay reachable without a
	// swipe.
	const items: Item[] = [
		{ href: '/companion', labelKey: 'companion.nav.persona', icon: IdCard, exact: true },
		{ href: '/companion/voice', labelKey: 'companion.nav.voice', icon: AudioLines },
		{ href: '/companion/work', labelKey: 'companion.nav.work', icon: Briefcase },
	];

	function isActive(item: Item): boolean {
		return item.exact
			? $page.url.pathname === item.href
			: $page.url.pathname.startsWith(item.href);
	}
</script>

<div class="flex flex-col gap-6 md:flex-row md:gap-8">
	<nav
		class="flex flex-wrap gap-1 border-b border-border pb-2 md:w-48 md:flex-none md:flex-col md:flex-nowrap md:border-b-0 md:pb-0"
		aria-label={t(locale, 'companion.nav.aria-label')}
	>
		<p
			class="hidden px-3 pb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground md:block"
		>
			{t(locale, 'companion.nav.heading')}
		</p>
		{#each items as item (item.href)}
			{@const Icon = item.icon}
			<a
				href={item.href}
				aria-current={isActive(item) ? 'page' : undefined}
				class={`flex flex-none items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors ${
					isActive(item)
						? 'bg-accent font-medium text-foreground'
						: 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
				}`}
			>
				<Icon class="size-4 flex-none" />
				{t(locale, item.labelKey)}
			</a>
		{/each}
	</nav>
	<div class="min-w-0 flex-1">
		{@render children()}
	</div>
</div>
