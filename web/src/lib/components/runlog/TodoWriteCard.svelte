<script lang="ts">
	import { Circle, Loader2, CheckCircle2 } from 'lucide-svelte';

	let {
		todos = [],
		inline = false,
	}: {
		todos?: Array<{ status: string; content: string; activeForm: string }>;
		inline?: boolean;
	} = $props();

	let completed = $derived(todos.filter((t) => t.status === 'completed').length);
	let total = $derived(todos.length);
	let pct = $derived(total > 0 ? Math.round((completed / total) * 100) : 0);
</script>

{#if inline}
	<!-- Compact inline preview in header -->
	<span class="text-muted-foreground/70 font-mono">
		{completed}/{total} done
	</span>
{:else}
	<!-- Full card in expanded body -->
	<div class="space-y-2 min-w-0">
		<!-- Header: N/M counter + progress bar -->
		<div class="flex items-center gap-2">
			<span class="text-xs text-muted-foreground tabular-nums shrink-0">{completed}/{total} completed</span>
			{#if total > 0}
				<div class="flex-1 h-1 rounded-full bg-muted/60 overflow-hidden">
					<div
						class="h-full rounded-full bg-green-500 transition-all duration-300"
						style="width: {pct}%"
					></div>
				</div>
			{/if}
		</div>

		<!-- Todo rows -->
		<ul class="space-y-1">
			{#each todos as todo}
				<li class="flex items-start gap-2 text-xs min-w-0">
					{#if todo.status === 'completed'}
						<CheckCircle2 class="size-3.5 text-green-400 shrink-0 mt-0.5" />
						<span class="line-through text-muted-foreground/50 break-words min-w-0">{todo.content}</span>
					{:else if todo.status === 'in_progress'}
						<Loader2 class="size-3.5 text-primary animate-spin shrink-0 mt-0.5" />
						<span class="italic text-foreground/80 break-words min-w-0">{todo.activeForm || todo.content}</span>
					{:else}
						<Circle class="size-3.5 text-muted-foreground/40 shrink-0 mt-0.5" />
						<span class="text-muted-foreground/70 break-words min-w-0">{todo.content}</span>
					{/if}
				</li>
			{/each}
		</ul>
	</div>
{/if}
