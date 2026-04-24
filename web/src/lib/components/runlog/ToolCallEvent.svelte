<script lang="ts">
	import {
		Terminal,
		FileText,
		FilePlus,
		FileEdit,
		Search,
		Asterisk,
		Sparkles,
		Globe,
		Box,
		Copy,
		Check,
		Loader2,
		CheckCircle2,
		XCircle,
	} from 'lucide-svelte';
	import { slide } from 'svelte/transition';
	import type { CliEnvelope } from './types';
	import TodoWriteCard from './TodoWriteCard.svelte';

	let {
		data,
		collapsed,
		ontoggle,
	}: {
		data: {
			name: string;
			input: Record<string, unknown>;
			id?: string;
			pairedResult?: {
				isError: boolean;
				text: string;
				raw: unknown;
				parsedEnvelope: CliEnvelope | null;
				exitCode?: number;
			};
		};
		collapsed: boolean;
		ontoggle: () => void;
	} = $props();

	type IconComponent = typeof Terminal;

	// Icon per tool name
	function toolIcon(name: string): IconComponent {
		const n = name.toLowerCase();
		if (n === 'bash') return Terminal;
		if (n === 'read') return FileText;
		if (n === 'write') return FilePlus;
		if (n === 'edit') return FileEdit;
		if (n === 'grep' || n === 'multisearch') return Search;
		if (n === 'glob') return Asterisk;
		if (n === 'skill') return Sparkles;
		if (n === 'webfetch' || n === 'websearch') return Globe;
		if (n === 'pitchbox' || n.startsWith('pitchbox:')) return Box;
		return Terminal;
	}

	let Icon = $derived(toolIcon(data.name));

	let isBashTool = $derived(data.name.toLowerCase() === 'bash');
	let isTodoWrite = $derived(data.name === 'TodoWrite');
	let command = $derived(isBashTool ? String(data.input.command ?? '') : '');
	let isPitchboxCmd = $derived(isBashTool && command.trimStart().startsWith('pitchbox '));
	let description = $derived(
		isBashTool && data.input.description ? String(data.input.description) : '',
	);

	let filePath = $derived(
		String(
			data.input.file_path ?? data.input.path ?? data.input.pattern ?? data.input.glob ?? '',
		),
	);
	let fileName = $derived(filePath ? filePath.split('/').filter(Boolean).pop() ?? filePath : '');

	let copied = $state(false);
	async function copyCommand(e: MouseEvent) {
		e.stopPropagation();
		try {
			await navigator.clipboard.writeText(command);
			copied = true;
			setTimeout(() => (copied = false), 1200);
		} catch {
			// ignore
		}
	}

	let commandPreview = $derived(
		command.length > 100 ? command.slice(0, 100).trimEnd() + '…' : command,
	);

	// Status derived from paired result
	let pr = $derived(data.pairedResult);
	let statusKind = $derived<'pending' | 'ok' | 'error'>(
		!pr ? 'pending' : pr.isError ? 'error' : 'ok',
	);

	function describeEnvelopeData(d: unknown): string {
		if (!d || typeof d !== 'object') return String(d ?? '');
		if (Array.isArray(d)) return `${d.length} items`;
		const obj = d as Record<string, unknown>;
		if ('runId' in obj && ('accounts' in obj || 'campaign' in obj)) {
			const parts = [`run #${obj.runId} started`];
			if (obj.project) parts.push(`project ${obj.project}`);
			if (Array.isArray(obj.accounts)) parts.push(`${obj.accounts.length} accounts`);
			if (obj.contacted != null) parts.push(`${obj.contacted} contacted`);
			return parts.join(' · ');
		}
		if ('runId' in obj && 'candidatesFetched' in obj) return `${obj.candidatesFetched} candidates fetched`;
		if ('runId' in obj && 'inserted' in obj) return `${obj.inserted} drafts created`;
		if ('runId' in obj && 'staged' in obj) return `${obj.staged} staged candidates`;
		return `{${Object.keys(obj).slice(0, 5).join(', ')}}`;
	}
</script>

<div class="min-w-0">
	<!-- Header row + copy button wrapper -->
	<div class="flex items-center gap-1 min-w-0">
		<button
			onclick={ontoggle}
			class="flex items-center gap-2 flex-1 text-left hover:text-foreground/80 transition-colors min-w-0 group"
			aria-expanded={!collapsed}
		>
			<Icon class="size-3.5 text-blue-400 shrink-0" />

			<!-- Tool name chip -->
			<span
				class="rounded bg-blue-950/50 border border-blue-500/30 text-blue-300 text-[10px] font-mono px-1.5 py-0.5 shrink-0 font-semibold"
			>
				{data.name}
			</span>

			<!-- Inline preview -->
			<span class="flex-1 min-w-0 text-xs text-muted-foreground truncate">
				{#if isBashTool}
					{#if isPitchboxCmd}
						<span class="text-orange-400 font-mono">
							{command.trimStart().slice('pitchbox '.length).split(/\s/)[0]}
						</span>
						<span class="text-muted-foreground/60 font-mono"
							>{' ' +
								command
									.trimStart()
									.slice('pitchbox '.length)
									.replace(/^\S+\s*/, '')
									.slice(0, 60)}</span
						>
					{:else}
						<span class="font-mono">$ {commandPreview}</span>
					{/if}
					{#if description}
						<span class="text-muted-foreground/50 italic ml-2">— {description.slice(0, 50)}</span>
					{/if}
				{:else if data.name.toLowerCase() === 'read'}
					<span class="font-mono text-muted-foreground/80">{fileName}</span>
				{:else if data.name.toLowerCase() === 'write'}
					<span class="font-mono">{fileName}</span>
					{#if data.input.content}
						<span class="ml-1 text-muted-foreground/50"
							>· {String(data.input.content).length} chars</span
						>
					{/if}
				{:else if data.name.toLowerCase() === 'edit'}
					<span class="font-mono">{fileName}</span>
					<span class="ml-1 text-muted-foreground/50">· edit</span>
				{:else if data.name.toLowerCase() === 'grep'}
					<span class="font-mono">"{data.input.pattern}"</span>
					{#if data.input.path}
						<span class="text-muted-foreground/50 ml-1">{data.input.path}</span>
					{/if}
				{:else if data.name.toLowerCase() === 'skill'}
					Launching <span class="font-semibold">{data.input.skill ?? '—'}</span>
				{:else if isTodoWrite}
					<TodoWriteCard todos={data.input.todos as { status: string; content: string; activeForm: string }[]} inline />
				{:else}
					<span class="text-muted-foreground/50">…</span>
				{/if}
			</span>

			<!-- Status badge -->
			<span class="shrink-0 flex items-center gap-1">
				{#if statusKind === 'pending'}
					<Loader2 class="size-3 animate-spin text-amber-400" />
					<span class="text-[10px] text-amber-400/80 font-mono">running</span>
				{:else if statusKind === 'error'}
					<XCircle class="size-3 text-destructive" />
					{#if pr?.exitCode !== undefined}
						<span class="text-[10px] font-mono rounded px-1 py-0.5 bg-destructive/15 text-destructive"
							>exit {pr.exitCode}</span
						>
					{:else}
						<span class="text-[10px] font-mono text-destructive">error</span>
					{/if}
				{:else}
					<CheckCircle2 class="size-3 text-green-400" />
					{#if isBashTool && pr?.exitCode !== undefined}
						<span class="text-[10px] font-mono rounded px-1 py-0.5 bg-green-500/10 text-green-400"
							>exit {pr.exitCode}</span
						>
					{:else}
						<span class="text-[10px] font-mono text-green-400/70">ok</span>
					{/if}
				{/if}
			</span>

			<span
				class="text-xs text-muted-foreground/50 shrink-0 group-hover:text-muted-foreground"
			>
				{collapsed ? 'expand' : 'collapse'}
			</span>
		</button>

		<!-- Copy button for Bash — outside the toggle button to avoid nesting -->
		{#if isBashTool && command}
			<button
				onclick={copyCommand}
				class="shrink-0 text-muted-foreground/40 hover:text-muted-foreground transition-colors p-0.5 rounded"
				aria-label="Copy command"
			>
				{#if copied}
					<Check class="size-3 text-green-400" />
				{:else}
					<Copy class="size-3" />
				{/if}
			</button>
		{/if}
	</div>

	<!-- Expanded body -->
	{#if !collapsed}
		<div transition:slide={{ duration: 160 }} class="mt-2 min-w-0 space-y-2">
			<!-- Input section -->
			<div>
				<p class="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/50 mb-1">Input</p>
				{#if isBashTool}
					<div class="min-w-0 max-w-full overflow-x-auto rounded bg-muted/60 border border-border/50">
						<pre class="font-mono text-xs whitespace-pre p-2 text-foreground/90 min-w-0">{command}</pre>
					</div>
					{#if description}
						<p class="text-xs text-muted-foreground/70 italic mt-1">{description}</p>
					{/if}
				{:else if isTodoWrite}
					<TodoWriteCard todos={data.input.todos as { status: string; content: string; activeForm: string }[]} />
				{:else if Object.keys(data.input).length > 0}
					<dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs min-w-0">
						{#each Object.entries(data.input) as [k, v]}
							<dt class="text-muted-foreground/60 font-mono shrink-0 pt-0.5">{k}</dt>
							<dd class="min-w-0 break-all">
								{#if typeof v === 'string' && v.length > 60}
									<div class="min-w-0 max-w-full overflow-x-auto rounded bg-muted/60 border border-border/50">
										<pre class="font-mono text-[10px] whitespace-pre p-1.5 min-w-0">{v}</pre>
									</div>
								{:else}
									<span class="font-mono text-foreground/80">{JSON.stringify(v)}</span>
								{/if}
							</dd>
						{/each}
					</dl>
				{:else}
					<p class="text-xs text-muted-foreground/50 italic">No input parameters</p>
				{/if}
			</div>

			<!-- Output section (only if paired result is available) -->
			{#if pr}
				<div>
					<p class="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/50 mb-1">Output</p>
					{#if pr.isError}
						<div class="rounded bg-destructive/10 border border-destructive/30 p-2 overflow-x-auto">
							<pre class="font-mono text-xs whitespace-pre-wrap break-all text-destructive/90">{pr.text}</pre>
						</div>
					{:else if pr.parsedEnvelope}
						{@const env = pr.parsedEnvelope}
						{#if env.ok}
							{#if isTodoWrite}
								<!-- TodoWrite result is trivial, de-emphasise it -->
								<p class="text-xs text-muted-foreground/50 italic">Todos updated.</p>
							{:else}
								<dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs min-w-0">
									{#each Object.entries((env.data as Record<string, unknown>) ?? {}) as [k, v]}
										<dt class="text-muted-foreground/60 font-mono shrink-0 pt-0.5">{k}</dt>
										<dd class="min-w-0 font-mono text-foreground/80 break-all">{JSON.stringify(v)}</dd>
									{/each}
								</dl>
							{/if}
						{:else}
							<p class="text-xs font-medium text-destructive">{env.error}</p>
							{#if env.details}
								<pre class="mt-1 font-mono text-[10px] text-muted-foreground whitespace-pre-wrap break-all">{JSON.stringify(env.details, null, 2)}</pre>
							{/if}
						{/if}
					{:else}
						<div class="min-w-0 max-w-full overflow-x-auto max-h-48 rounded border border-border/50 bg-muted/60">
							<pre class="font-mono text-xs whitespace-pre p-2 min-w-0">{pr.text}</pre>
						</div>
					{/if}
				</div>
			{/if}
		</div>
	{/if}
</div>
