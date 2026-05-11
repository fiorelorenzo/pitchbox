<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import Seo from '$lib/components/Seo.svelte';
	import * as Card from '$lib/components/ui/card';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Textarea } from '$lib/components/ui/textarea';
	import * as Dialog from '$lib/components/ui/dialog';
	import { relativeTime } from '$lib/utils/time';
	import { toast } from 'svelte-sonner';

	type PlaybookRow = {
		id: number;
		slug: string;
		name: string;
		description: string | null;
		isBuiltin: boolean;
		updatedAt: string | Date;
	};

	let { data }: { data: { playbooks: PlaybookRow[] } } = $props();

	let createOpen = $state(false);
	let slug = $state('');
	let name = $state('');
	let description = $state('');
	let body = $state('');
	let busy = $state(false);

	async function create() {
		busy = true;
		try {
			const res = await fetch('/api/playbooks', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					slug: slug.trim(),
					name: name.trim(),
					description: description.trim() || undefined,
					body,
				}),
			});
			if (!res.ok) {
				toast.error('Create failed', { description: res.status === 409 ? 'Slug already taken' : '' });
				return;
			}
			const payload = await res.json();
			toast.success('Playbook created');
			createOpen = false;
			slug = name = description = body = '';
			await goto(`/playbooks/${payload.playbook.id}`);
		} finally {
			busy = false;
		}
	}

	async function remove(id: number) {
		if (!confirm('Delete this playbook?')) return;
		const res = await fetch(`/api/playbooks/${id}`, { method: 'DELETE' });
		if (!res.ok) toast.error('Delete failed');
		else await invalidateAll();
	}
</script>

<Seo title="Playbooks" description="Edit or create the markdown playbooks the agent runner executes." />

<PageHeader
	title="Playbooks"
	description="Markdown instructions the agent runner executes. Built-in entries are read-only — duplicate to customise."
>
	{#snippet actions()}
		<Button onclick={() => (createOpen = true)}>New playbook</Button>
	{/snippet}
</PageHeader>

<div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 mt-4">
	{#each data.playbooks as p (p.id)}
		<Card.Root size="sm">
			<Card.Header class="flex flex-row flex-nowrap items-start gap-2 space-y-0">
				<div class="min-w-0 flex-1">
					<Card.Title class="text-base truncate">{p.name}</Card.Title>
					<p class="text-[10px] font-mono text-muted-foreground/80 mt-0.5 truncate">{p.slug}</p>
				</div>
				{#if p.isBuiltin}
					<span
						class="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground"
					>
						built-in
					</span>
				{/if}
			</Card.Header>
			<Card.Content class="flex flex-col gap-3">
				{#if p.description}
					<p class="text-xs text-muted-foreground line-clamp-3">{p.description}</p>
				{/if}
				<p class="text-[10px] text-muted-foreground/70">
					Updated {relativeTime(p.updatedAt)}
				</p>
				<div class="flex gap-2">
					<Button size="sm" variant="outline" onclick={() => goto(`/playbooks/${p.id}`)}>
						{p.isBuiltin ? 'View' : 'Edit'}
					</Button>
					{#if !p.isBuiltin}
						<Button size="sm" variant="ghost" onclick={() => remove(p.id)}>Delete</Button>
					{/if}
				</div>
			</Card.Content>
		</Card.Root>
	{/each}
</div>

<Dialog.Root bind:open={createOpen}>
	<Dialog.Content class="max-w-2xl">
		<Dialog.Header>
			<Dialog.Title>New playbook</Dialog.Title>
			<Dialog.Description>
				Markdown the agent runner will execute. Pick a slug matching the campaign skill that should
				use this playbook (e.g. reddit-scout).
			</Dialog.Description>
		</Dialog.Header>
		<div class="flex flex-col gap-3">
			<label class="flex flex-col gap-1 text-xs">
				Slug
				<Input bind:value={slug} placeholder="my-playbook" />
			</label>
			<label class="flex flex-col gap-1 text-xs">
				Name
				<Input bind:value={name} placeholder="My playbook" />
			</label>
			<label class="flex flex-col gap-1 text-xs">
				Description
				<Input bind:value={description} placeholder="What this playbook does" />
			</label>
			<label class="flex flex-col gap-1 text-xs">
				Body (markdown)
				<Textarea bind:value={body} rows={14} class="font-mono text-xs" />
			</label>
			<div class="flex justify-end gap-2">
				<Button variant="ghost" onclick={() => (createOpen = false)}>Cancel</Button>
				<Button
					onclick={create}
					disabled={busy || !slug.trim() || !name.trim() || body.trim().length === 0}
				>
					Create
				</Button>
			</div>
		</div>
	</Dialog.Content>
</Dialog.Root>
