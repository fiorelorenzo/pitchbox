<script lang="ts">
	import '../app.css';
	import Sidebar from '$lib/components/Sidebar.svelte';

	let { children } = $props();
</script>

<div class="min-h-screen bg-slate-950 text-slate-100 flex">
	<Sidebar />
	<main class="flex-1 p-6 overflow-hidden">{@render children()}</main>
</div>
