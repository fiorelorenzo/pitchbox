<script lang="ts">
	import '../app.css';
	import Sidebar from '$lib/components/Sidebar.svelte';
	import { Toaster } from '$lib/components/ui/sonner';

	let { children } = $props();
</script>

<div class="dark min-h-screen bg-background text-foreground flex">
	<Sidebar />
	<main class="flex-1 overflow-auto p-6">{@render children()}</main>
</div>

<Toaster />
