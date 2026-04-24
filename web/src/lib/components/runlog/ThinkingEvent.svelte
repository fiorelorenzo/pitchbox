<script lang="ts">
	import { Brain } from 'lucide-svelte';
	import { slide } from 'svelte/transition';
	import Markdown from '$lib/components/Markdown.svelte';

	let {
		data,
		collapsed,
		ontoggle,
	}: { data: { text: string }; collapsed: boolean; ontoggle: () => void } = $props();

	let preview = $derived(
		data.text.replace(/\s+/g, ' ').trim().slice(0, 80) +
			(data.text.replace(/\s+/g, ' ').trim().length > 80 ? '…' : ''),
	);
</script>

<div class="min-w-0">
	<button
		onclick={ontoggle}
		class="flex items-center gap-2 w-full text-left hover:text-foreground/80 transition-colors group"
		aria-expanded={!collapsed}
	>
		<Brain class="size-3.5 text-slate-400 shrink-0" />
		<span class="text-xs font-medium text-muted-foreground">Thinking</span>
		{#if collapsed && preview}
			<span class="text-xs text-muted-foreground/60 italic truncate min-w-0 flex-1">{preview}</span>
		{/if}
		<span class="text-xs text-muted-foreground/50 ml-auto shrink-0 group-hover:text-muted-foreground">
			{collapsed ? 'expand' : 'collapse'}
		</span>
	</button>

	{#if !collapsed}
		<div transition:slide={{ duration: 160 }} class="mt-2 min-w-0">
			<Markdown source={data.text} class="italic text-muted-foreground/80 text-xs" />
		</div>
	{/if}
</div>
