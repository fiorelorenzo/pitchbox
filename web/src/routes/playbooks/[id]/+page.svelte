<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import Seo from '$lib/components/Seo.svelte';
	import * as Card from '$lib/components/ui/card';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Textarea } from '$lib/components/ui/textarea';
	import { toast } from 'svelte-sonner';
	import { untrack } from 'svelte';

	type Playbook = {
		id: number;
		slug: string;
		name: string;
		description: string | null;
		body: string;
		isBuiltin: boolean;
		updatedAt: string | Date;
	};

	let { data }: { data: { playbook: Playbook } } = $props();

	let name = $state(untrack(() => data.playbook.name));
	let description = $state(untrack(() => data.playbook.description ?? ''));
	let body = $state(untrack(() => data.playbook.body));
	let saving = $state(false);

	const readOnly = $derived(data.playbook.isBuiltin);
	const dirty = $derived(
		name !== data.playbook.name ||
			(description || null) !== data.playbook.description ||
			body !== data.playbook.body,
	);

	async function save() {
		saving = true;
		try {
			const res = await fetch(`/api/playbooks/${data.playbook.id}`, {
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					name,
					description: description.trim() || null,
					body,
				}),
			});
			if (!res.ok) {
				toast.error('Save failed');
				return;
			}
			toast.success('Saved');
			await invalidateAll();
		} finally {
			saving = false;
		}
	}

	async function duplicate() {
		const newSlug = prompt('New slug for the copy?', `${data.playbook.slug}-copy`);
		if (!newSlug) return;
		const res = await fetch('/api/playbooks', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				slug: newSlug.trim(),
				name: `${data.playbook.name} (copy)`,
				description: data.playbook.description ?? undefined,
				body: data.playbook.body,
			}),
		});
		if (!res.ok) {
			toast.error(res.status === 409 ? 'Slug already taken' : 'Duplicate failed');
			return;
		}
		const payload = await res.json();
		await goto(`/playbooks/${payload.playbook.id}`);
	}
</script>

<Seo title={`Playbook · ${data.playbook.name}`} description="Edit a Pitchbox playbook." />

<PageHeader title={data.playbook.name} description={`Slug: ${data.playbook.slug}`}>
	{#snippet actions()}
		<Button variant="outline" onclick={() => goto('/playbooks')}>Back</Button>
		<Button variant="outline" onclick={duplicate}>Duplicate</Button>
		{#if !readOnly}
			<Button onclick={save} disabled={saving || !dirty}>{saving ? 'Saving…' : 'Save'}</Button>
		{/if}
	{/snippet}
</PageHeader>

{#if readOnly}
	<p class="mt-3 text-xs text-muted-foreground">
		This is a built-in playbook and cannot be edited in place. Duplicate it to customise.
	</p>
{/if}

<Card.Root size="sm" class="mt-4">
	<Card.Content class="flex flex-col gap-3">
		<label class="flex flex-col gap-1 text-xs">
			Name
			<Input bind:value={name} disabled={readOnly} />
		</label>
		<label class="flex flex-col gap-1 text-xs">
			Description
			<Input bind:value={description} disabled={readOnly} />
		</label>
		<label class="flex flex-col gap-1 text-xs">
			Body (markdown)
			<Textarea
				bind:value={body}
				rows={28}
				disabled={readOnly}
				class="font-mono text-xs"
			/>
		</label>
	</Card.Content>
</Card.Root>
