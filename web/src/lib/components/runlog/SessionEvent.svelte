<script lang="ts">
	import { Sparkles } from 'lucide-svelte';
	import * as Tooltip from '$lib/components/ui/tooltip';

	let {
		data,
	}: {
		data: { sessionId?: string; model?: string; cwd?: string };
	} = $props();

	let shortId = $derived(data.sessionId?.slice(0, 8) ?? '—');

	let cwdSegments = $derived(
		data.cwd
			? data.cwd
					.replace(/\\/g, '/')
					.split('/')
					.filter(Boolean)
					.slice(-2)
					.join('/')
			: '',
	);
</script>

<div class="flex items-center gap-2 flex-wrap min-w-0 py-0.5">
	<Sparkles class="size-3.5 text-violet-400 shrink-0" />
	<span class="text-xs font-medium text-muted-foreground">Session</span>

	{#if data.model}
		<Tooltip.Provider>
			<Tooltip.Root>
				<Tooltip.Trigger>
					<span class="rounded bg-violet-950/50 border border-violet-500/30 text-violet-300 text-[10px] font-mono px-1.5 py-0.5 truncate max-w-[140px] cursor-default">
						{data.model}
					</span>
				</Tooltip.Trigger>
				<Tooltip.Content>
					<p class="font-mono text-xs">{data.model}</p>
				</Tooltip.Content>
			</Tooltip.Root>
		</Tooltip.Provider>
	{/if}

	{#if data.sessionId}
		<Tooltip.Provider>
			<Tooltip.Root>
				<Tooltip.Trigger>
					<span class="rounded bg-muted border border-border text-muted-foreground text-[10px] font-mono px-1.5 py-0.5 cursor-default">
						{shortId}
					</span>
				</Tooltip.Trigger>
				<Tooltip.Content>
					<p class="font-mono text-xs">{data.sessionId}</p>
				</Tooltip.Content>
			</Tooltip.Root>
		</Tooltip.Provider>
	{/if}

	{#if cwdSegments}
		<Tooltip.Provider>
			<Tooltip.Root>
				<Tooltip.Trigger>
					<span class="text-[10px] text-muted-foreground/70 font-mono truncate max-w-[180px] cursor-default">
						…/{cwdSegments}
					</span>
				</Tooltip.Trigger>
				<Tooltip.Content>
					<p class="font-mono text-xs">{data.cwd}</p>
				</Tooltip.Content>
			</Tooltip.Root>
		</Tooltip.Provider>
	{/if}
</div>
