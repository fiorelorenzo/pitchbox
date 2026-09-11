<script lang="ts">
	import * as Card from '$lib/components/ui/card';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { page } from '$app/stores';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import Seo from '$lib/components/Seo.svelte';
	import { toast } from 'svelte-sonner';
	import { enhance } from '$app/forms';
	import { untrack } from 'svelte';
	import { t, type Locale } from '$lib/i18n/index.js';

	type Policy = {
		drafts_days: number;
		run_events_days: number;
		draft_events_days: number;
		webhook_deliveries_days: number;
	};
	type PageData = { policy: Policy; floor: number; isAdmin?: boolean };

	let { data, form }: { data: PageData; form: { saved?: Policy; error?: string } | null } = $props();
	const isAdmin = $derived(data.isAdmin ?? true);
	const locale = $derived($page.data.locale as Locale);

	let drafts_days = $state(untrack(() => data.policy.drafts_days));
	let run_events_days = $state(untrack(() => data.policy.run_events_days));
	let draft_events_days = $state(untrack(() => data.policy.draft_events_days));
	let webhook_deliveries_days = $state(untrack(() => data.policy.webhook_deliveries_days));
	let busy = $state(false);

	$effect(() => {
		if (form?.saved) {
			toast.success(t(locale, 'settings.retention.success-saved'));
			drafts_days = form.saved.drafts_days;
			run_events_days = form.saved.run_events_days;
			draft_events_days = form.saved.draft_events_days;
			webhook_deliveries_days = form.saved.webhook_deliveries_days;
		} else if (form?.error) {
			toast.error(form.error);
		}
	});
</script>

<Seo
	title={t(locale, 'settings.retention.seo-title')}
	description={t(locale, 'settings.retention.seo-description')}
/>

<PageHeader
	title={t(locale, 'settings.retention.title')}
	description={t(locale, 'settings.retention.description')}
/>

<div class="grid gap-4">
	<Card.Root>
		<Card.Header>
			<Card.Title>{t(locale, 'settings.retention.policy-title')}</Card.Title>
			<Card.Description>
				{t(locale, 'settings.retention.policy-description', { floor: data.floor })}
			</Card.Description>
		</Card.Header>
		<Card.Content>
			<form
				method="POST"
				use:enhance={() => {
					busy = true;
					return async ({ update }) => {
						await update();
						busy = false;
					};
				}}
				class="grid max-w-md gap-4"
			>
				<div class="grid gap-1.5">
					<label class="text-sm font-medium" for="drafts_days"
						>{t(locale, 'settings.retention.field-drafts')}</label
					>
					<Input id="drafts_days" name="drafts_days" type="number" min={data.floor} bind:value={drafts_days} disabled={!isAdmin} />
				</div>
				<div class="grid gap-1.5">
					<label class="text-sm font-medium" for="run_events_days"
						>{t(locale, 'settings.retention.field-run-events')}</label
					>
					<Input id="run_events_days" name="run_events_days" type="number" min={data.floor} bind:value={run_events_days} disabled={!isAdmin} />
				</div>
				<div class="grid gap-1.5">
					<label class="text-sm font-medium" for="draft_events_days"
						>{t(locale, 'settings.retention.field-draft-events')}</label
					>
					<Input id="draft_events_days" name="draft_events_days" type="number" min={data.floor} bind:value={draft_events_days} disabled={!isAdmin} />
				</div>
				<div class="grid gap-1.5">
					<label class="text-sm font-medium" for="webhook_deliveries_days"
						>{t(locale, 'settings.retention.field-webhook-deliveries')}</label
					>
					<Input id="webhook_deliveries_days" name="webhook_deliveries_days" type="number" min={data.floor} bind:value={webhook_deliveries_days} disabled={!isAdmin} />
				</div>
				{#if isAdmin}
					<div>
						<Button type="submit" disabled={busy}>{t(locale, 'settings.retention.save')}</Button>
					</div>
				{/if}
			</form>
		</Card.Content>
	</Card.Root>
</div>
