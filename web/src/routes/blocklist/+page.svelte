<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { toast } from 'svelte-sonner';
	import { Plus, Trash2 } from 'lucide-svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import Seo from '$lib/components/Seo.svelte';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { SelectField } from '$lib/components/ui/select-field';
	import * as Card from '$lib/components/ui/card';
	import * as Table from '$lib/components/ui/table';
	import { relativeTime } from '$lib/utils/time';
	import StatusBadge from '$lib/components/StatusBadge.svelte';

	type Entry = {
		id: number;
		platformId: number;
		platformSlug: string | null;
		kind: string;
		value: string;
		reason: string | null;
		scope: string;
		projectId: number | null;
		projectSlug: string | null;
		addedAt: string | Date;
	};
	type Platform = { id: number; slug: string };
	type Project = { id: number; slug: string; name: string };

	let {
		data,
	}: {
		data: { entries: Entry[]; platforms: Platform[]; projects: Project[] };
	} = $props();

	const KINDS = [
		{ value: 'subreddit', label: 'Subreddit' },
		{ value: 'user', label: 'User' },
		{ value: 'keyword', label: 'Keyword' },
	];

	let platformId = $state<number | undefined>(undefined);
	$effect(() => {
		if (platformId === undefined && data.platforms.length > 0) {
			platformId = data.platforms[0].id;
		}
	});
	let kind = $state<string>('subreddit');
	let value = $state('');
	let reason = $state('');
	let scope = $state<'global' | 'project'>('global');
	let projectId = $state<number | undefined>(undefined);
	let saving = $state(false);

	const platformOptions = $derived(
		data.platforms.map((p) => ({ value: p.id, label: p.slug })),
	);
	const projectOptions = $derived(
		data.projects.map((p) => ({ value: p.id, label: p.name })),
	);
	const scopeOptions = [
		{ value: 'global', label: 'Global (all projects)' },
		{ value: 'project', label: 'Project' },
	];

	async function submit(e: Event) {
		e.preventDefault();
		if (!platformId || !value.trim()) {
			toast.error('Platform and value are required');
			return;
		}
		saving = true;
		try {
			const res = await fetch('/api/blocklist', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					platformId,
					kind,
					value: value.trim(),
					reason: reason.trim() || null,
					scope,
					projectId: scope === 'project' ? projectId : null,
				}),
			});
			if (!res.ok) throw new Error(await res.text());
			toast.success('Added');
			value = '';
			reason = '';
			await invalidateAll();
		} catch (err) {
			toast.error('Failed', { description: (err as Error).message });
		} finally {
			saving = false;
		}
	}

	async function remove(id: number) {
		try {
			const res = await fetch(`/api/blocklist/${id}`, { method: 'DELETE' });
			if (!res.ok) throw new Error(await res.text());
			toast.success('Removed');
			await invalidateAll();
		} catch (err) {
			toast.error('Failed', { description: (err as Error).message });
		}
	}

</script>

<Seo
	title="Blocklist"
	description="Subreddits, users and keywords that campaigns will skip during outreach."
/>

<PageHeader
	title="Blocklist"
	description="Subreddits, users and keywords that campaigns will skip. Scope to one project or apply globally across all projects."
/>

<div class="grid grid-cols-1 lg:grid-cols-3 gap-4">
	<Card.Root class="lg:col-span-1">
		<Card.Header>
			<Card.Title class="text-base">Add entry</Card.Title>
			<Card.Description class="text-xs">
				Scouts will skip matches before drafting.
			</Card.Description>
		</Card.Header>
		<Card.Content>
			<form onsubmit={submit} class="flex flex-col gap-3">
				<label class="flex flex-col gap-1 text-xs">
					<span class="text-muted-foreground">Platform</span>
					<SelectField bind:value={platformId} options={platformOptions} fullWidth />
				</label>
				<label class="flex flex-col gap-1 text-xs">
					<span class="text-muted-foreground">Kind</span>
					<SelectField bind:value={kind} options={KINDS} fullWidth />
				</label>
				<label class="flex flex-col gap-1 text-xs">
					<span class="text-muted-foreground">Value</span>
					<Input
						bind:value
						placeholder={kind === 'subreddit'
							? 'r/example (or just example)'
							: kind === 'user'
								? 'u/example'
								: 'spam keyword'}
					/>
				</label>
				<label class="flex flex-col gap-1 text-xs">
					<span class="text-muted-foreground">Reason (optional)</span>
					<Input bind:value={reason} placeholder="e.g. off-topic, banned sub, …" />
				</label>
				<label class="flex flex-col gap-1 text-xs">
					<span class="text-muted-foreground">Scope</span>
					<SelectField bind:value={scope} options={scopeOptions} fullWidth />
				</label>
				{#if scope === 'project'}
					<label class="flex flex-col gap-1 text-xs">
						<span class="text-muted-foreground">Project</span>
						<SelectField
							bind:value={projectId}
							options={projectOptions}
							placeholder="— choose —"
							fullWidth
						/>
					</label>
				{/if}
				<Button type="submit" loading={saving}>
					<Plus class="size-4" />
					Add to blocklist
				</Button>
			</form>
		</Card.Content>
	</Card.Root>

	<Card.Root class="lg:col-span-2">
		<Card.Header>
			<Card.Title class="text-base">Entries</Card.Title>
			<Card.Description class="text-xs">{data.entries.length} total</Card.Description>
		</Card.Header>
		<Card.Content>
			{#if data.entries.length === 0}
				<p class="text-sm text-muted-foreground italic py-6 text-center">
					Empty blocklist — add your first entry on the left.
				</p>
			{:else}
				<Table.Root>
					<Table.Header>
						<Table.Row>
							<Table.Head>Kind</Table.Head>
							<Table.Head>Value</Table.Head>
							<Table.Head>Platform</Table.Head>
							<Table.Head>Scope</Table.Head>
							<Table.Head>Added</Table.Head>
							<Table.Head class="w-12"></Table.Head>
						</Table.Row>
					</Table.Header>
					<Table.Body>
						{#each data.entries as e (e.id)}
							<Table.Row>
								<Table.Cell>
									<StatusBadge domain="blocklist-kind" value={e.kind} />
								</Table.Cell>
								<Table.Cell class="font-mono text-xs">{e.value}</Table.Cell>
								<Table.Cell class="text-xs text-muted-foreground">
									{e.platformSlug ?? `#${e.platformId}`}
								</Table.Cell>
								<Table.Cell class="text-xs text-muted-foreground">
									{e.scope}{e.projectSlug ? ` · ${e.projectSlug}` : ''}
								</Table.Cell>
								<Table.Cell class="text-xs text-muted-foreground" title={String(e.addedAt)}>
									{relativeTime(e.addedAt)}
								</Table.Cell>
								<Table.Cell>
									<Button
										variant="ghost"
										size="icon"
										aria-label="Remove"
										onclick={() => remove(e.id)}
										class="text-muted-foreground hover:text-destructive"
									>
										<Trash2 class="size-4" />
									</Button>
								</Table.Cell>
							</Table.Row>
						{/each}
					</Table.Body>
				</Table.Root>
			{/if}
		</Card.Content>
	</Card.Root>
</div>
