<script lang="ts">
	import PageHeader from '$lib/components/PageHeader.svelte';
	import Seo from '$lib/components/Seo.svelte';
	import * as Card from '$lib/components/ui/card';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { relativeTime } from '$lib/utils/time';
	import { invalidateAll } from '$app/navigation';
	import { toast } from 'svelte-sonner';
	import { untrack } from 'svelte';

	type Notification = {
		id: number;
		kind: string;
		title: string;
		body: string | null;
		severity: string;
		readAt: string | Date | null;
		createdAt: string | Date;
		payload: Record<string, unknown>;
	};

	type PageData = {
		notifications: Notification[];
		webhooks: { url?: string };
	};

	let { data }: { data: PageData } = $props();
	let webhookUrl = $state(untrack(() => data.webhooks.url ?? ''));
	let savingWebhook = $state(false);

	async function markAllRead() {
		const res = await fetch('/api/notifications', { method: 'POST' });
		if (!res.ok) toast.error('Failed to mark as read');
		else await invalidateAll();
	}

	async function saveWebhook() {
		savingWebhook = true;
		try {
			const res = await fetch('/api/settings/webhooks', {
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ url: webhookUrl.trim() || null }),
			});
			if (!res.ok) toast.error('Save failed');
			else toast.success('Webhook saved');
		} finally {
			savingWebhook = false;
		}
	}

	const SEVERITY_TONE: Record<string, string> = {
		info: 'text-foreground',
		success: 'text-emerald-300',
		warning: 'text-amber-300',
		error: 'text-rose-300',
	};
</script>

<Seo title="Notifications" description="Recent system events and notification delivery configuration." />

<PageHeader title="Notifications" description="Recent run, draft, and reply events.">
	{#snippet actions()}
		<Button variant="outline" onclick={markAllRead}>Mark all as read</Button>
	{/snippet}
</PageHeader>

<div class="grid grid-cols-1 lg:grid-cols-3 gap-4 mt-4">
	<div class="lg:col-span-2 flex flex-col gap-2">
		{#if data.notifications.length === 0}
			<p class="text-sm text-muted-foreground">No notifications yet.</p>
		{/if}
		{#each data.notifications as n (n.id)}
			<Card.Root size="sm">
				<Card.Content class="py-3">
					<div class="flex items-start gap-3">
						<span
							class="mt-1 inline-block size-2 rounded-full {n.readAt
								? 'bg-muted-foreground/40'
								: 'bg-sky-400'}"
						></span>
						<div class="min-w-0 flex-1">
							<p class="text-sm font-medium {SEVERITY_TONE[n.severity] ?? ''}">{n.title}</p>
							{#if n.body}
								<p class="text-xs text-muted-foreground mt-0.5">{n.body}</p>
							{/if}
							<p class="text-[10px] text-muted-foreground/70 mt-1">
								<span class="font-mono">{n.kind}</span> · {relativeTime(n.createdAt)}
							</p>
						</div>
					</div>
				</Card.Content>
			</Card.Root>
		{/each}
	</div>

	<div>
		<Card.Root size="sm">
			<Card.Header>
				<Card.Title class="text-base">Outgoing webhook</Card.Title>
			</Card.Header>
			<Card.Content class="flex flex-col gap-3">
				<p class="text-xs text-muted-foreground">
					POST a JSON payload to a URL for every notification. Leave empty to disable. Wire this to
					Slack, Discord, or your own service.
				</p>
				<Input bind:value={webhookUrl} placeholder="https://hooks.example.com/..." />
				<Button onclick={saveWebhook} disabled={savingWebhook}>Save</Button>
			</Card.Content>
		</Card.Root>
	</div>
</div>
