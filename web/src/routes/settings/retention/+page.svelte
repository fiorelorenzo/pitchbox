<script lang="ts">
	import * as Card from '$lib/components/ui/card';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import Seo from '$lib/components/Seo.svelte';
	import { toast } from 'svelte-sonner';
	import { enhance } from '$app/forms';
	import { untrack } from 'svelte';

	type Policy = { drafts_days: number; run_events_days: number; draft_events_days: number };
	type PageData = { policy: Policy; floor: number; isAdmin?: boolean };

	let { data, form }: { data: PageData; form: { saved?: Policy; error?: string } | null } = $props();
	const isAdmin = $derived(data.isAdmin ?? true);

	let drafts_days = $state(untrack(() => data.policy.drafts_days));
	let run_events_days = $state(untrack(() => data.policy.run_events_days));
	let draft_events_days = $state(untrack(() => data.policy.draft_events_days));
	let busy = $state(false);

	$effect(() => {
		if (form?.saved) {
			toast.success('Retention policy saved');
			drafts_days = form.saved.drafts_days;
			run_events_days = form.saved.run_events_days;
			draft_events_days = form.saved.draft_events_days;
		} else if (form?.error) {
			toast.error(form.error);
		}
	});
</script>

<Seo title="Settings - Retention" description="Configure how long drafts and event logs are kept before pruning." />

<PageHeader
	title="Retention"
	description="How long terminal drafts and event logs are kept before the daemon prunes them."
/>

<div class="mt-4 grid gap-4">
	<Card.Root>
		<Card.Header>
			<Card.Title>Policy</Card.Title>
			<Card.Description>
				Values below {data.floor} days are clamped to {data.floor} server-side. Contact history is never pruned by this policy.
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
					<label class="text-sm font-medium" for="drafts_days">Drafts (sent / rejected / replied)</label>
					<Input id="drafts_days" name="drafts_days" type="number" min={data.floor} bind:value={drafts_days} disabled={!isAdmin} />
				</div>
				<div class="grid gap-1.5">
					<label class="text-sm font-medium" for="run_events_days">Run events</label>
					<Input id="run_events_days" name="run_events_days" type="number" min={data.floor} bind:value={run_events_days} disabled={!isAdmin} />
				</div>
				<div class="grid gap-1.5">
					<label class="text-sm font-medium" for="draft_events_days">Draft events</label>
					<Input id="draft_events_days" name="draft_events_days" type="number" min={data.floor} bind:value={draft_events_days} disabled={!isAdmin} />
				</div>
				{#if isAdmin}
					<div>
						<Button type="submit" disabled={busy}>Save</Button>
					</div>
				{/if}
			</form>
		</Card.Content>
	</Card.Root>
</div>
