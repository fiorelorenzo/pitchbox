<script lang="ts">
	import * as Card from '$lib/components/ui/card';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Cpu, RefreshCw, ChevronDown, ChevronRight } from 'lucide-svelte';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import { toast } from 'svelte-sonner';

	type RunnerConfig = {
		model?: string;
		maxTurns?: number;
		extraArgs?: string[];
	};

	type Runner = {
		slug: string;
		label: string;
		implemented: boolean;
		available: boolean;
		version: string | null;
		path: string | null;
		error: string | null;
		detectedAt: string;
		config: RunnerConfig;
	};

	let { runners = $bindable() }: { runners: Runner[] } = $props();

	let detecting = $state(false);
	let expanded = $state<Record<string, boolean>>({});
	let saving = $state<Record<string, boolean>>({});

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
			const merged: Runner[] = body.runners.map((r: Omit<Runner, 'config'>) => ({
				...r,
				config: runners.find((cur) => cur.slug === r.slug)?.config ?? {},
			}));
			runners = merged;
			toast.success('Runners re-detected');
		} finally {
			detecting = false;
		}
	}

	async function saveConfig(slug: string) {
		const runner = runners.find((r) => r.slug === slug);
		if (!runner) return;
		saving[slug] = true;
		try {
			const res = await fetch('/api/settings/runner-config', {
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ slug, config: runner.config }),
			});
			if (!res.ok) {
				toast.error('Save failed');
				return;
			}
			toast.success('Runner config saved');
		} finally {
			saving[slug] = false;
		}
	}

	function setModel(slug: string, v: string) {
		const r = runners.find((x) => x.slug === slug);
		if (!r) return;
		r.config = { ...r.config, model: v.trim() || undefined };
		runners = runners;
	}

	function setMaxTurns(slug: string, v: string) {
		const r = runners.find((x) => x.slug === slug);
		if (!r) return;
		const n = Number(v);
		r.config = { ...r.config, maxTurns: Number.isFinite(n) && n > 0 ? n : undefined };
		runners = runners;
	}

	function setExtraArgs(slug: string, v: string) {
		const r = runners.find((x) => x.slug === slug);
		if (!r) return;
		const parts = v
			.split(/\s+/)
			.map((s) => s.trim())
			.filter(Boolean);
		r.config = { ...r.config, extraArgs: parts.length > 0 ? parts : undefined };
		runners = runners;
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
						{#if r.implemented}
							<button
								type="button"
								class="mt-1.5 inline-flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground"
								onclick={() => (expanded[r.slug] = !expanded[r.slug])}
							>
								{#if expanded[r.slug]}
									<ChevronDown class="size-3" />
								{:else}
									<ChevronRight class="size-3" />
								{/if}
								Configure
							</button>
							{#if expanded[r.slug]}
								<div class="mt-2 flex flex-col gap-2 rounded-md border border-border/60 p-3">
									<div class="grid grid-cols-2 gap-2">
										<label class="text-[10px] text-muted-foreground">
											Model
											<Input
												value={r.config.model ?? ''}
												placeholder="e.g. claude-sonnet-4-6"
												class="h-7 text-xs mt-1"
												oninput={(e) => setModel(r.slug, e.currentTarget.value)}
											/>
										</label>
										<label class="text-[10px] text-muted-foreground">
											Max turns
											<Input
												type="number"
												min="1"
												value={r.config.maxTurns ?? ''}
												placeholder="default"
												class="h-7 text-xs mt-1"
												oninput={(e) => setMaxTurns(r.slug, e.currentTarget.value)}
											/>
										</label>
									</div>
									<label class="text-[10px] text-muted-foreground">
										Extra CLI args (space-separated)
										<Input
											value={(r.config.extraArgs ?? []).join(' ')}
											placeholder="--flag value"
											class="h-7 text-xs mt-1 font-mono"
											oninput={(e) => setExtraArgs(r.slug, e.currentTarget.value)}
										/>
									</label>
									<div class="flex justify-end">
										<Button
											size="sm"
											onclick={() => saveConfig(r.slug)}
											disabled={saving[r.slug]}
										>
											Save
										</Button>
									</div>
								</div>
							{/if}
						{/if}
					</div>
				</li>
			{/each}
		</ul>
	</Card.Content>
</Card.Root>
