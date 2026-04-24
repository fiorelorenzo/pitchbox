<script lang="ts">
	import { CheckCircle2, XCircle } from 'lucide-svelte';
	import { slide } from 'svelte/transition';
	import type { CliEnvelope } from './types';

	let {
		data,
		collapsed,
		ontoggle,
	}: {
		data: {
			raw: unknown;
			text: string;
			parsedEnvelope?: CliEnvelope | null;
			isError: boolean;
			toolUseId?: string;
		};
		collapsed: boolean;
		ontoggle: () => void;
	} = $props();

	let env = $derived(data.parsedEnvelope);

	function describeEnvelopeData(d: unknown): string {
		if (!d || typeof d !== 'object') return String(d ?? '');
		if (Array.isArray(d)) return `${d.length} items`;
		const obj = d as Record<string, unknown>;

		// run:start shape
		if ('runId' in obj && ('accounts' in obj || 'campaign' in obj)) {
			const parts = [`run #${obj.runId} started`];
			if (obj.project) parts.push(`project ${obj.project}`);
			if (Array.isArray(obj.accounts)) parts.push(`${obj.accounts.length} accounts`);
			if (obj.contacted != null) parts.push(`${obj.contacted} contacted`);
			return parts.join(' · ');
		}
		// reddit:scout
		if ('runId' in obj && 'candidatesFetched' in obj) {
			return `${obj.candidatesFetched} candidates fetched`;
		}
		// drafts:create
		if ('runId' in obj && 'inserted' in obj) {
			return `${obj.inserted} drafts created`;
		}
		// staging:candidates
		if ('runId' in obj && 'staged' in obj) {
			return `${obj.staged} staged candidates`;
		}
		// fallback: show key list
		return `{${Object.keys(obj).slice(0, 5).join(', ')}}`;
	}

	let envelopePreview = $derived(env ? describeEnvelopeData(env.data) : '');
</script>

<div class="min-w-0">
	<button
		onclick={ontoggle}
		class="flex items-center gap-2 w-full text-left hover:text-foreground/80 transition-colors min-w-0 group"
		aria-expanded={!collapsed}
	>
		{#if data.isError}
			<XCircle class="size-3.5 text-destructive shrink-0" />
			<span class="text-xs font-medium text-destructive">Error</span>
		{:else if env}
			{#if env.ok}
				<CheckCircle2 class="size-3.5 text-green-400 shrink-0" />
				<span class="text-xs text-muted-foreground">{envelopePreview}</span>
			{:else}
				<XCircle class="size-3.5 text-destructive shrink-0" />
				<span class="text-xs font-medium text-destructive">{env.error ?? 'Command failed'}</span>
			{/if}
		{:else}
			<CheckCircle2 class="size-3.5 text-green-400/70 shrink-0" />
			<span class="text-xs text-muted-foreground truncate flex-1">
				{data.text.split('\n')[0].slice(0, 80)}
				{data.text.split('\n')[0].length > 80 ? '…' : ''}
			</span>
		{/if}

		<span class="text-xs text-muted-foreground/50 ml-auto shrink-0 group-hover:text-muted-foreground">
			{collapsed ? 'expand' : 'collapse'}
		</span>
	</button>

	{#if !collapsed}
		<div transition:slide={{ duration: 160 }} class="mt-2 min-w-0">
			{#if data.isError}
				<div class="rounded bg-destructive/10 border border-destructive/30 p-2 overflow-x-auto">
					<pre class="font-mono text-xs whitespace-pre-wrap break-all text-destructive/90">{data.text}</pre>
				</div>
			{:else if env}
				{#if env.ok}
					<dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs min-w-0">
						{#each Object.entries((env.data as Record<string, unknown>) ?? {}) as [k, v]}
							<dt class="text-muted-foreground/60 font-mono shrink-0 pt-0.5">{k}</dt>
							<dd class="min-w-0 font-mono text-foreground/80 break-all">{JSON.stringify(v)}</dd>
						{/each}
					</dl>
				{:else}
					<p class="text-xs font-medium text-destructive">{env.error}</p>
					{#if env.details}
						<pre class="mt-1 font-mono text-[10px] text-muted-foreground whitespace-pre-wrap break-all">{JSON.stringify(env.details, null, 2)}</pre>
					{/if}
				{/if}
			{:else}
				<div class="min-w-0 max-w-full overflow-x-auto max-h-48 rounded border border-border/50 bg-muted/60">
					<pre class="font-mono text-xs whitespace-pre p-2 min-w-0">{data.text}</pre>
				</div>
			{/if}
		</div>
	{/if}
</div>
