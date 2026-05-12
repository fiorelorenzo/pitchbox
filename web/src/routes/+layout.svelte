<script lang="ts">
	import '../app.css';
	import '$lib/platforms/register';
	import Sidebar from '$lib/components/Sidebar.svelte';
	import { Toaster } from '$lib/components/ui/sonner';
	import { ModeWatcher } from 'mode-watcher';
	import { Menu, X } from 'lucide-svelte';
	import { page } from '$app/stores';

	let { children } = $props();

	// Off-canvas sidebar state for < md viewports.
	let sidebarOpen = $state(false);

	// Close the drawer whenever the route changes so navigating from the drawer
	// doesn't leave it stuck open on the new page.
	$effect(() => {
		void $page.url.pathname;
		sidebarOpen = false;
	});
</script>

<svelte:head>
	<meta name="viewport" content="width=device-width, initial-scale=1" />
	<meta name="theme-color" content="#0a0a0a" />
</svelte:head>

<!--
  ModeWatcher toggles `.dark` on <html> based on the user's preference (system/light/dark)
  and persists the choice in localStorage. Default to dark to preserve historical look.
-->
<ModeWatcher defaultMode="dark" />

<!--
  h-screen + overflow-hidden on the outer shell makes the sidebar truly fixed:
  main is the only scrollable surface, so the sidebar stays put when page
  content is longer than the viewport.
-->
<div class="h-screen overflow-hidden bg-background text-foreground flex">
	<!-- Mobile hamburger: visible only below md. Fixed top-left so it floats above content. -->
	<button
		type="button"
		onclick={() => (sidebarOpen = true)}
		class="md:hidden fixed top-3 left-3 z-40 inline-flex items-center justify-center size-9 rounded-md border border-border bg-background/90 backdrop-blur shadow-sm hover:bg-accent/60 transition-colors"
		aria-label="Open navigation"
		aria-expanded={sidebarOpen}
	>
		<Menu class="size-4" />
	</button>

	<!-- Backdrop for mobile drawer -->
	{#if sidebarOpen}
		<button
			type="button"
			aria-label="Close navigation"
			onclick={() => (sidebarOpen = false)}
			class="md:hidden fixed inset-0 z-40 bg-black/50 backdrop-blur-sm"
		></button>
	{/if}

	<!--
	  Sidebar: static column on md+, off-canvas drawer below md.
	  The drawer slides in from the left when sidebarOpen is true.
	-->
	<div
		class={[
			'z-50 transition-transform duration-200 md:transition-none',
			'md:static md:translate-x-0 md:z-auto',
			'fixed inset-y-0 left-0',
			sidebarOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0',
		].join(' ')}
	>
		<!-- Close button shown only inside the drawer on small screens -->
		{#if sidebarOpen}
			<button
				type="button"
				onclick={() => (sidebarOpen = false)}
				class="md:hidden absolute top-3 right-3 z-10 inline-flex items-center justify-center size-8 rounded-md hover:bg-accent/60 transition-colors"
				aria-label="Close navigation"
			>
				<X class="size-4" />
			</button>
		{/if}
		<Sidebar />
	</div>

	<main class="flex-1 overflow-auto p-4 sm:p-6 pt-14 md:pt-6 min-w-0">{@render children()}</main>
</div>

<Toaster />
