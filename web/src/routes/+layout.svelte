<script lang="ts">
	import '../app.css';
	import '$lib/platforms/register';
	import Sidebar from '$lib/components/Sidebar.svelte';
	import SseIndicator from '$lib/realtime/SseIndicator.svelte';
	import { Toaster } from '$lib/components/ui/sonner';
	import CommandPalette from '$lib/components/command-palette/CommandPalette.svelte';
	import { ModeWatcher } from 'mode-watcher';
	import { Menu, X } from '@lucide/svelte';
	import { page } from '$app/stores';

	let { children, data } = $props();

	// The app shell (navigation, sign-out, notification polling, daemon health,
	// the SSE stream, the command palette) is for someone who is signed in. On
	// /login and /invite with auth on it used to render anyway, which meant a
	// logged-out visitor saw a full sidebar whose every link bounced back to
	// /login, a "Sign out" link, an "unauthenticated" error toast raised by the
	// notification poll's own 401, and a "Daemon offline" indicator that was
	// simply false (the daemon polls 401 too, and the store reads any non-ok as
	// dead). Self-hosting with auth off has no session and full access, so the
	// shell stays in that case.
	const showShell = $derived(!data.authOn || data.signedIn);

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
<!--
	Mounted before the page content on purpose. Svelte runs child effects before
	parent ones, so a page that raises a toast from an `$effect` during its own
	mount (the "Run link ignored" warning on a stale `?run=` deep link, for one)
	would emit it before a Toaster declared further down had mounted, and the
	toast was silently dropped. It only ever appeared on a client-side
	navigation, when the Toaster was already up. Position is unaffected: the
	toaster is fixed-position, not in flow.
-->
<Toaster />

{#if showShell}
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

		<!--
		  Mobile connection indicator: the sidebar (and SystemStatusCard inside it)
		  is off-canvas below md, so without this there is no way to see stream
		  health on a phone short of opening the drawer.
		-->
		<div
			class="md:hidden fixed top-3 right-3 z-40 rounded-md border border-border bg-background/90 backdrop-blur shadow-sm px-2 py-1.5"
		>
			<SseIndicator />
		</div>

		<!-- Backdrop for mobile drawer -->
		{#if sidebarOpen}
			<button
				type="button"
				aria-label="Close navigation"
				onclick={() => (sidebarOpen = false)}
				class="md:hidden fixed inset-0 z-40 bg-overlay/50 backdrop-blur-sm"
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

	<!-- Global Cmd/Ctrl-K command palette: single instance for the whole app. -->
	<CommandPalette />
{:else}
	<!--
		Unauthenticated routes with auth on (/login, /invite): the page and nothing
		else. No navigation to bounce off the auth guard, no notification or daemon
		polling to 401, no SSE stream to reconnect at, no command palette.
	-->
	<div class="h-screen overflow-hidden bg-background text-foreground">
		<main class="h-full overflow-auto p-4 sm:p-6">{@render children()}</main>
	</div>
{/if}
