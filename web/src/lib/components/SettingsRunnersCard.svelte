<script lang="ts">
	import * as Card from '$lib/components/ui/card';
	import { Button } from '$lib/components/ui/button';
	import { Cpu, RefreshCw } from 'lucide-svelte';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import { toast } from 'svelte-sonner';

	type Runner = {
		slug: string;
		label: string;
		implemented: boolean;
		available: boolean;
		version: string | null;
		path: string | null;
		error: string | null;
		detectedAt: string;
	};

	let { runners = $bindable() }: { runners: Runner[] } = $props();

	let detecting = $state(false);

	async function redetect() {
		if (detecting) return;
		detecting = true;
		try {
			const res = await fetch('/api/runners', { method: 'POST' });
			if (!res.ok) {
				toast.error('Re-detection failed');
				return;
			}
			const body = await res.json();
			runners = body.runners;
			toast.success('Runners re-detected');
		} finally {
			detecting = false;
		}
	}
</script>

<Card.Root size="sm">
	<Card.Header class="flex flex-row flex-nowrap items-center gap-2 space-y-0">
		<Cpu class="size-4 shrink-0 text-muted-foreground" />
		<Card.Title class="text-base min-w-0 flex-1 truncate">Agent runners</Card.Title>
		<Button
			variant="outline"
			size="sm"
			onclick={redetect}
			disabled={detecting}
			class="shrink-0"
		>
			<RefreshCw class="size-3 {detecting ? 'animate-spin' : ''}" />
			Re-detect
		</Button>
	</Card.Header>
	<Card.Content class="flex flex-col gap-3">
		<p class="text-xs text-muted-foreground">
			Detected at startup by probing each runner CLI. Re-detect after installing or upgrading a
			runner.
		</p>
		<ul class="flex flex-col gap-2">
			{#each runners as r (r.slug)}
				<li class="flex items-start gap-2 text-sm">
					<span
						class="mt-1 size-2 rounded-full shrink-0 {r.available
							? 'bg-emerald-400'
							: 'bg-muted-foreground/40'}"
					></span>
					<div class="min-w-0 flex-1">
						<div class="flex flex-wrap items-center gap-1.5">
							<span class="font-mono text-xs">{r.slug}</span>
							{#if !r.implemented}
								<StatusBadge domain="run-status" value="queued" size="sm" />
							{:else if r.available}
								<StatusBadge domain="run-status" value="success" size="sm" />
							{:else}
								<StatusBadge domain="run-status" value="failed" size="sm" />
							{/if}
							{#if r.version}
								<span class="text-xs text-muted-foreground">· {r.version}</span>
							{/if}
						</div>
						{#if r.path}
							<p class="text-[10px] text-muted-foreground/70 font-mono truncate mt-0.5">
								{r.path}
							</p>
						{/if}
						{#if r.error}
							<p class="text-[10px] text-muted-foreground/80 mt-0.5">{r.error}</p>
						{/if}
					</div>
				</li>
			{/each}
		</ul>
	</Card.Content>
</Card.Root>
