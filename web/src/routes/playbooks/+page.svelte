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
	import * as Dialog from '$lib/components/ui/dialog';
	import * as AlertDialog from '$lib/components/ui/alert-dialog';
	import { relativeTime } from '$lib/utils/time';
	import { toast } from 'svelte-sonner';
	import PageContainer from '$lib/components/PageContainer.svelte';

	type PlaybookRow = {
		id: number;
		slug: string;
		name: string;
		description: string | null;
		isBuiltin: boolean;
		updatedAt: string | Date;
	};

	let { data }: { data: { playbooks: PlaybookRow[]; isAdmin?: boolean } } = $props();
	const isAdmin = $derived(data.isAdmin ?? true);
	const locale = $derived($page.data.locale as Locale);

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
				if (res.status === 403) toast.error(t(locale, 'playbooks.error-admin-required'));
				else toast.error(t(locale, 'playbooks.toast-create-failed-title'), { description: res.status === 409 ? t(locale, 'playbooks.error-slug-taken') : '' });
				return;
			}
			const payload = await res.json();
			toast.success(t(locale, 'playbooks.toast-created'));
			createOpen = false;
			slug = name = description = body = '';
			await goto(`/playbooks/${payload.playbook.id}`);
		} finally {
			busy = false;
		}
	}

	let deleteDialogOpen = $state(false);
	let deleteTarget = $state<PlaybookRow | null>(null);
	let deleting = $state(false);

	function openDeleteDialog(p: PlaybookRow) {
		deleteTarget = p;
		deleteDialogOpen = true;
	}

	async function confirmRemove() {
		if (!deleteTarget) return;
		deleting = true;
		try {
			const res = await fetch(`/api/playbooks/${deleteTarget.id}`, { method: 'DELETE' });
			if (!res.ok) {
				toast.error(res.status === 403 ? t(locale, 'playbooks.error-admin-required') : t(locale, 'playbooks.toast-delete-failed'));
				return;
			}
			deleteDialogOpen = false;
			deleteTarget = null;
			await invalidateAll();
		} finally {
			deleting = false;
		}
	}
</script>

<PageContainer size="narrow">
<Seo title={t(locale, 'playbooks.seo-title')} description={t(locale, 'playbooks.seo-description')} />

<PageHeader
	title={t(locale, 'playbooks.title')}
	description={t(locale, 'playbooks.header-description')}
>
	{#snippet actions()}
		{#if isAdmin}
			<Button onclick={() => (createOpen = true)}>{t(locale, 'playbooks.new-button')}</Button>
		{/if}
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
					{t(locale, 'playbooks.builtin-badge')}
					</span>
				{/if}
			</Card.Header>
			<Card.Content class="flex flex-col gap-3">
				{#if p.description}
					<p class="text-xs text-muted-foreground line-clamp-3">{p.description}</p>
				{/if}
				<p class="text-[10px] text-muted-foreground/70">
					{t(locale, 'playbooks.updated-at', { when: relativeTime(p.updatedAt) })}
				</p>
				<div class="flex gap-2">
					<Button size="sm" variant="outline" onclick={() => goto(`/playbooks/${p.id}`)}>
						{p.isBuiltin ? t(locale, 'playbooks.view-button') : t(locale, 'playbooks.edit-button')}
					</Button>
					{#if !p.isBuiltin && isAdmin}
						<Button size="sm" variant="ghost" onclick={() => openDeleteDialog(p)}>{t(locale, 'playbooks.delete-button')}</Button>
					{/if}
				</div>
			</Card.Content>
		</Card.Root>
	{/each}
</div>

<Dialog.Root bind:open={createOpen}>
	<Dialog.Content class="max-w-2xl">
		<Dialog.Header>
			<Dialog.Title>{t(locale, 'playbooks.create-dialog-title')}</Dialog.Title>
			<Dialog.Description>
				{t(locale, 'playbooks.create-dialog-description')}
			</Dialog.Description>
		</Dialog.Header>
		<div class="flex flex-col gap-3">
			<label class="flex flex-col gap-1 text-xs">
				{t(locale, 'playbooks.label-slug')}
				<Input bind:value={slug} placeholder={t(locale, 'playbooks.slug-placeholder')} />
			</label>
			<label class="flex flex-col gap-1 text-xs">
				{t(locale, 'playbooks.label-name')}
				<Input bind:value={name} placeholder={t(locale, 'playbooks.name-placeholder')} />
			</label>
			<label class="flex flex-col gap-1 text-xs">
				{t(locale, 'playbooks.label-description')}
				<Input bind:value={description} placeholder={t(locale, 'playbooks.description-placeholder')} />
			</label>
			<label class="flex flex-col gap-1 text-xs">
				{t(locale, 'playbooks.label-body')}
				<Textarea bind:value={body} rows={14} class="font-mono text-xs" />
			</label>
			<div class="flex justify-end gap-2">
				<Button variant="ghost" onclick={() => (createOpen = false)}>{t(locale, 'playbooks.cancel-button')}</Button>
				<Button
					onclick={create}
					disabled={busy || !slug.trim() || !name.trim() || body.trim().length === 0}
				>
					{t(locale, 'playbooks.create-button')}
				</Button>
			</div>
		</div>
	</Dialog.Content>
</Dialog.Root>

<AlertDialog.Root bind:open={deleteDialogOpen}>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>{t(locale, 'playbooks.delete-dialog-title', { name: deleteTarget?.name ?? '' })}</AlertDialog.Title>
			<AlertDialog.Description>
				{t(locale, 'playbooks.delete-dialog-description')}
			</AlertDialog.Description>
		</AlertDialog.Header>
		<AlertDialog.Footer>
			<AlertDialog.Cancel onclick={() => (deleteDialogOpen = false)}>{t(locale, 'playbooks.cancel-button')}</AlertDialog.Cancel>
			<AlertDialog.Action onclick={confirmRemove} disabled={deleting}>
				{deleting ? t(locale, 'playbooks.deleting-button') : t(locale, 'playbooks.delete-confirm-button')}
			</AlertDialog.Action>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>
</PageContainer>
