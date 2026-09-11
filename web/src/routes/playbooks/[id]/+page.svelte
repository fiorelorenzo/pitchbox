<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
	import { page } from '$app/stores';
	import { t, type Locale } from '$lib/i18n/index.js';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import Seo from '$lib/components/Seo.svelte';
	import * as Card from '$lib/components/ui/card';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Textarea } from '$lib/components/ui/textarea';
	import { toast } from 'svelte-sonner';
	import { untrack } from 'svelte';
	import PageContainer from '$lib/components/PageContainer.svelte';

	type Playbook = {
		id: number;
		slug: string;
		name: string;
		description: string | null;
		body: string;
		isBuiltin: boolean;
		updatedAt: string | Date;
	};

	let { data }: { data: { playbook: Playbook; isAdmin?: boolean } } = $props();
	const isAdmin = $derived(data.isAdmin ?? true);
	const locale = $derived($page.data.locale as Locale);

	let name = $state(untrack(() => data.playbook.name));
	let description = $state(untrack(() => data.playbook.description ?? ''));
	let body = $state(untrack(() => data.playbook.body));
	let saving = $state(false);

	const builtin = $derived(data.playbook.isBuiltin);
	const readOnly = $derived(builtin || !isAdmin);
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
			toast.error(res.status === 403 ? t(locale, 'playbooks.error-admin-required') : t(locale, 'playbooks.toast-save-failed'));
				return;
			}
			toast.success(t(locale, 'playbooks.toast-saved'));
			await invalidateAll();
		} finally {
			saving = false;
		}
	}

	async function duplicate() {
		const newSlug = prompt(t(locale, 'playbooks.duplicate-prompt'), `${data.playbook.slug}-copy`);
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
			if (res.status === 403) toast.error(t(locale, 'playbooks.error-admin-required'));
			else toast.error(res.status === 409 ? t(locale, 'playbooks.error-slug-taken') : t(locale, 'playbooks.toast-duplicate-failed'));
			return;
		}
		const payload = await res.json();
		await goto(`/playbooks/${payload.playbook.id}`);
	}
</script>

<PageContainer size="default">
<Seo title={t(locale, 'playbooks.detail-seo-title', { name: data.playbook.name })} description={t(locale, 'playbooks.detail-seo-description')} />

<PageHeader title={data.playbook.name} description={t(locale, 'playbooks.slug-label', { slug: data.playbook.slug })}>
	{#snippet actions()}
		<Button variant="outline" onclick={() => goto('/playbooks')}>{t(locale, 'playbooks.back-button')}</Button>
		{#if isAdmin}
			<Button variant="outline" onclick={duplicate}>{t(locale, 'playbooks.duplicate-button')}</Button>
		{/if}
		{#if !readOnly}
			<Button onclick={save} disabled={!dirty} loading={saving}>{t(locale, 'playbooks.save-button')}</Button>
		{/if}
	{/snippet}
</PageHeader>

{#if builtin}
	<p class="mt-3 text-xs text-muted-foreground">
		{t(locale, 'playbooks.builtin-notice')}
	</p>
{:else if !isAdmin}
	<p class="mt-3 text-xs text-muted-foreground">{t(locale, 'playbooks.non-admin-notice')}</p>
{/if}

<Card.Root size="sm" class="mt-4">
	<Card.Content class="flex flex-col gap-3">
		<label class="flex flex-col gap-1 text-xs">
			{t(locale, 'playbooks.label-name')}
			<Input bind:value={name} disabled={readOnly} />
		</label>
		<label class="flex flex-col gap-1 text-xs">
			{t(locale, 'playbooks.label-description')}
			<Input bind:value={description} disabled={readOnly} />
		</label>
		<label class="flex flex-col gap-1 text-xs">
			{t(locale, 'playbooks.label-body')}
			<Textarea
				bind:value={body}
				rows={28}
				disabled={readOnly}
				class="font-mono text-xs"
			/>
		</label>
	</Card.Content>
</Card.Root>
</PageContainer>
