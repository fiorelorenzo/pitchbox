<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { page } from '$app/stores';
	import { t, type Locale } from '$lib/i18n/index.js';
	import { toast } from 'svelte-sonner';
	import { Plus, Trash2, Shield } from '@lucide/svelte';
	import EmptyState from '$lib/components/EmptyState.svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import Seo from '$lib/components/Seo.svelte';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { SelectField } from '$lib/components/ui/select-field';
	import * as Card from '$lib/components/ui/card';
	import * as Table from '$lib/components/ui/table';
	import * as AlertDialog from '$lib/components/ui/alert-dialog';
	import { relativeTime } from '$lib/utils/time';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import { badgeLabel } from '$lib/config/status-badges';
	import PageContainer from '$lib/components/PageContainer.svelte';

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
		data: { entries: Entry[]; platforms: Platform[]; projects: Project[]; isAdmin?: boolean };
	} = $props();
	const isAdmin = $derived(data.isAdmin ?? true);
	const locale = $derived($page.data.locale as Locale);

	const KINDS = $derived([
		{ value: 'subreddit', label: badgeLabel(locale, 'blocklist-kind', 'subreddit') },
		{ value: 'user', label: badgeLabel(locale, 'blocklist-kind', 'user') },
		{ value: 'keyword', label: badgeLabel(locale, 'blocklist-kind', 'keyword') },
	]);

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
	const scopeOptions = $derived([
		{ value: 'global', label: t(locale, 'blocklist.scope-option-global') },
		{ value: 'project', label: t(locale, 'blocklist.scope-option-project') },
	]);

	async function submit(e: Event) {
		e.preventDefault();
		if (!platformId || !value.trim()) {
			toast.error(t(locale, 'blocklist.error-required-fields'));
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
			toast.success(t(locale, 'blocklist.toast-added'));
			value = '';
			reason = '';
			await invalidateAll();
		} catch (err) {
			toast.error(t(locale, 'blocklist.toast-failed-title'), { description: (err as Error).message });
		} finally {
			saving = false;
		}
	}

	function entryLabel(entry: Entry): string {
		if (entry.kind === 'subreddit') return `r/${entry.value}`;
		if (entry.kind === 'user') return `u/${entry.value}`;
		return `"${entry.value}"`;
	}

	let deleteDialogOpen = $state(false);
	let deleteTarget = $state<Entry | null>(null);
	let removing = $state(false);

	function openDeleteDialog(entry: Entry) {
		deleteTarget = entry;
		deleteDialogOpen = true;
	}

	async function confirmRemove() {
		if (!deleteTarget) return;
		removing = true;
		try {
			const res = await fetch(`/api/blocklist/${deleteTarget.id}`, { method: 'DELETE' });
			if (!res.ok) {
				if (res.status === 403) {
					toast.error(t(locale, 'blocklist.error-admin-required'));
					return;
				}
				throw new Error(await res.text());
			}
			toast.success(t(locale, 'blocklist.toast-removed'));
			deleteDialogOpen = false;
			deleteTarget = null;
			await invalidateAll();
		} catch (err) {
			toast.error(t(locale, 'blocklist.toast-failed-title'), { description: (err as Error).message });
		} finally {
			removing = false;
		}
	}

</script>

<PageContainer size="default">
<Seo
	title={t(locale, 'blocklist.seo-title')}
	description={t(locale, 'blocklist.seo-description')}
/>

<PageHeader
	title={t(locale, 'blocklist.title')}
	description={t(locale, 'blocklist.header-description')}
/>

<div class="grid grid-cols-1 lg:grid-cols-3 gap-4">
	<Card.Root class="lg:col-span-1">
		<Card.Header>
			<Card.Title class="text-base">{t(locale, 'blocklist.add-entry-title')}</Card.Title>
			<Card.Description class="text-xs">
				{t(locale, 'blocklist.add-entry-description')}
			</Card.Description>
		</Card.Header>
		<Card.Content>
			<form onsubmit={submit} class="flex flex-col gap-3">
				<label class="flex flex-col gap-1 text-xs">
					<span class="text-muted-foreground">{t(locale, 'blocklist.label-platform')}</span>
					<SelectField bind:value={platformId} options={platformOptions} fullWidth />
				</label>
				<label class="flex flex-col gap-1 text-xs">
					<span class="text-muted-foreground">{t(locale, 'blocklist.label-kind')}</span>
					<SelectField bind:value={kind} options={KINDS} fullWidth />
				</label>
				<label class="flex flex-col gap-1 text-xs">
					<span class="text-muted-foreground">{t(locale, 'blocklist.label-value')}</span>
					<Input
						bind:value
						placeholder={kind === 'subreddit'
							? t(locale, 'blocklist.value-placeholder-subreddit')
							: kind === 'user'
								? t(locale, 'blocklist.value-placeholder-user')
								: t(locale, 'blocklist.value-placeholder-keyword')}
					/>
				</label>
				<label class="flex flex-col gap-1 text-xs">
					<span class="text-muted-foreground">{t(locale, 'blocklist.label-reason')}</span>
					<Input bind:value={reason} placeholder={t(locale, 'blocklist.reason-placeholder')} />
				</label>
				<label class="flex flex-col gap-1 text-xs">
					<span class="text-muted-foreground">{t(locale, 'blocklist.label-scope')}</span>
					<SelectField bind:value={scope} options={scopeOptions} fullWidth />
				</label>
				{#if scope === 'project'}
					<label class="flex flex-col gap-1 text-xs">
						<span class="text-muted-foreground">{t(locale, 'blocklist.label-project')}</span>
						<SelectField
							bind:value={projectId}
							options={projectOptions}
							placeholder={t(locale, 'blocklist.choose-placeholder')}
							fullWidth
						/>
					</label>
				{/if}
				<Button type="submit" loading={saving}>
					<Plus class="size-4" />
					{t(locale, 'blocklist.add-button')}
				</Button>
			</form>
		</Card.Content>
	</Card.Root>

	<Card.Root class="lg:col-span-2">
		<Card.Header>
			<Card.Title class="text-base">{t(locale, 'blocklist.entries-title')}</Card.Title>
			<Card.Description class="text-xs">{t(locale, 'blocklist.entries-total', { n: data.entries.length })}</Card.Description>
		</Card.Header>
		<Card.Content>
			{#if data.entries.length === 0}
				<EmptyState
					icon={Shield}
					title={t(locale, 'blocklist.empty-title')}
					description={t(locale, 'blocklist.empty-body')}
					size="sm"
				/>
			{:else}
				<Table.Root>
					<Table.Header>
						<Table.Row>
							<Table.Head>{t(locale, 'blocklist.col-kind')}</Table.Head>
							<Table.Head>{t(locale, 'blocklist.col-value')}</Table.Head>
							<Table.Head>{t(locale, 'blocklist.col-platform')}</Table.Head>
							<Table.Head>{t(locale, 'blocklist.col-scope')}</Table.Head>
							<Table.Head>{t(locale, 'blocklist.col-added')}</Table.Head>
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
									{relativeTime(e.addedAt, locale)}
								</Table.Cell>
								<Table.Cell>
									{#if isAdmin}
										<Button
											variant="ghost"
											size="icon"
											aria-label={t(locale, 'blocklist.aria-remove')}
											onclick={() => openDeleteDialog(e)}
											class="text-muted-foreground hover:text-destructive"
										>
											<Trash2 class="size-4" />
										</Button>
									{/if}
								</Table.Cell>
							</Table.Row>
						{/each}
					</Table.Body>
				</Table.Root>
			{/if}
		</Card.Content>
	</Card.Root>
</div>

<AlertDialog.Root bind:open={deleteDialogOpen}>
	<AlertDialog.Content>
		<AlertDialog.Header>
		<AlertDialog.Title>
			{t(locale, 'blocklist.delete-title', { label: deleteTarget ? entryLabel(deleteTarget) : t(locale, 'blocklist.default-entry-label') })}
		</AlertDialog.Title>
		<AlertDialog.Description>
			{t(locale, 'blocklist.delete-description', { label: deleteTarget ? entryLabel(deleteTarget) : t(locale, 'blocklist.default-entry-label') })}
		</AlertDialog.Description>
		</AlertDialog.Header>
		<AlertDialog.Footer>
			<AlertDialog.Cancel onclick={() => (deleteDialogOpen = false)}>{t(locale, 'blocklist.cancel-button')}</AlertDialog.Cancel>
			<AlertDialog.Action onclick={confirmRemove} disabled={removing}>
				{removing ? t(locale, 'blocklist.removing-button') : t(locale, 'blocklist.remove-button')}
			</AlertDialog.Action>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>
</PageContainer>
