<script lang="ts">
	import * as Card from '$lib/components/ui/card';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { SelectField } from '$lib/components/ui/select-field';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import { toast } from 'svelte-sonner';
	import {
		AGENT_RUNNER_META,
		RUNNER_CONFIG_SCHEMA,
		type RunnerConfigField,
	} from '@pitchbox/shared/agents/meta';

	type RunnerConfig = Record<string, unknown>;

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

	let {
		runner = $bindable(),
		isDefault,
		onSetDefault,
	}: {
		runner: Runner;
		isDefault: boolean;
		onSetDefault: () => void;
	} = $props();

	let saving = $state(false);

	const schemaFields = $derived<RunnerConfigField[]>(
		(AGENT_RUNNER_META.some((m) => m.slug === runner.slug) &&
			RUNNER_CONFIG_SCHEMA[runner.slug as keyof typeof RUNNER_CONFIG_SCHEMA]) ||
			[],
	);

	function setField(key: string, value: unknown) {
		runner.config = { ...runner.config, [key]: value };
	}

	async function save() {
		saving = true;
		try {
			const res = await fetch('/api/settings/runner-config', {
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ slug: runner.slug, config: runner.config }),
			});
			if (!res.ok) toast.error('Save failed');
			else toast.success('Runner config saved');
		} finally {
			saving = false;
		}
	}
</script>

<Card.Root size="sm" class={isDefault ? 'border-emerald-500/40 bg-emerald-500/[0.03]' : undefined}>
	<Card.Header class="flex flex-row items-start justify-between gap-2 space-y-0">
		<div class="min-w-0 flex-1">
			<div class="flex items-center gap-2 flex-wrap">
				<Card.Title class="text-base">{runner.label}</Card.Title>
				{#if !runner.implemented}
					<StatusBadge domain="run-status" value="queued" size="sm" />
				{:else if runner.available}
					<StatusBadge domain="run-status" value="success" size="sm" />
				{:else}
					<StatusBadge domain="run-status" value="failed" size="sm" />
				{/if}
				{#if isDefault}
					<span
						class="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-medium text-emerald-300"
					>
						default
					</span>
				{/if}
			</div>
			<p class="text-[10px] font-mono text-muted-foreground/80 mt-1">{runner.slug}</p>
			{#if runner.version}
				<p class="text-[11px] text-muted-foreground mt-0.5">{runner.version}</p>
			{/if}
			{#if runner.path}
				<p class="text-[10px] text-muted-foreground/70 font-mono truncate mt-0.5">
					{runner.path}
				</p>
			{/if}
			{#if !runner.implemented}
				<p class="text-[11px] text-amber-300 mt-1.5">Coming soon — adapter not implemented yet.</p>
			{:else if runner.error && !runner.available}
				<p class="text-[11px] text-rose-300 mt-1.5">{runner.error}</p>
			{/if}
		</div>
		{#if runner.implemented && runner.available && !isDefault}
			<Button size="sm" variant="outline" onclick={onSetDefault} class="shrink-0">
				Set as default
			</Button>
		{/if}
	</Card.Header>

	{#if runner.implemented && runner.available && schemaFields.length > 0}
		<Card.Content class="flex flex-col gap-3 pt-0">
			<div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
				{#each schemaFields as f (f.key)}
					<label class="flex flex-col gap-1 text-[11px] text-muted-foreground">
						<span>
							{f.label}
							{#if f.description}
								<span class="ml-1 text-muted-foreground/70">— {f.description}</span>
							{/if}
						</span>
						{#if f.kind === 'select'}
							{@const current = (runner.config[f.key] as string | undefined) ?? ''}
							{@const knownOpts = f.options.map((o) => ({ value: o, label: o }))}
							{@const opts = [{ value: '', label: 'CLI default' }, ...knownOpts]}
							<SelectField
								value={opts.some((o) => o.value === current) ? current : ''}
								onValueChange={(v) => setField(f.key, v || undefined)}
								options={opts}
								size="sm"
							/>
							{#if f.allowCustom}
								<Input
									value={current && !f.options.includes(current) ? current : ''}
									placeholder="Custom value (overrides selector above)"
									oninput={(e) => {
										const v = e.currentTarget.value.trim();
										setField(f.key, v || undefined);
									}}
									class="h-7 text-xs mt-1 font-mono"
								/>
							{/if}
						{:else if f.kind === 'number'}
							<Input
								type="number"
								min={f.min}
								max={f.max}
								value={(runner.config[f.key] as number | undefined) ?? ''}
								placeholder="default"
								oninput={(e) => {
									const n = Number(e.currentTarget.value);
									setField(f.key, Number.isFinite(n) && n > 0 ? n : undefined);
								}}
								class="h-7 text-xs"
							/>
						{:else if f.kind === 'string'}
							<Input
								value={(runner.config[f.key] as string | undefined) ?? ''}
								placeholder={f.placeholder ?? ''}
								oninput={(e) => setField(f.key, e.currentTarget.value || undefined)}
								class="h-7 text-xs"
							/>
						{/if}
					</label>
				{/each}
			</div>
			<div class="flex justify-end">
				<Button size="sm" onclick={save} disabled={saving}>
					{saving ? 'Saving…' : 'Save config'}
				</Button>
			</div>
		</Card.Content>
	{/if}
</Card.Root>
