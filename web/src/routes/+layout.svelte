<script lang="ts">
	import '../app.css';
	import '$lib/platforms/register';
	import Sidebar from '$lib/components/Sidebar.svelte';
	import { Toaster } from '$lib/components/ui/sonner';
	import { ModeWatcher } from 'mode-watcher';

	let { children } = $props();
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
	<Sidebar />
	<main class="flex-1 overflow-auto p-6 min-w-0">{@render children()}</main>
</div>

<Toaster />
