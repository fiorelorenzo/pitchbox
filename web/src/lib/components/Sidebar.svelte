<script lang="ts">
	import { Inbox, PlayCircle, Settings } from 'lucide-svelte';
</script>

<aside class="w-56 border-r border-slate-800 p-4 space-y-2">
	<h1 class="font-semibold text-xl mb-4">Pitchbox</h1>
	<a href="/inbox" class="flex items-center gap-2 p-2 rounded hover:bg-slate-900">
		<Inbox class="w-4 h-4" /> Inbox
	</a>
	<a href="/campaigns" class="flex items-center gap-2 p-2 rounded hover:bg-slate-900">
		<PlayCircle class="w-4 h-4" /> Campaigns
	</a>
	<a href="/settings" class="flex items-center gap-2 p-2 rounded hover:bg-slate-900">
		<Settings class="w-4 h-4" /> Settings
	</a>
</aside>
