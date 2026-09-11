<script lang="ts">
	import { page } from '$app/stores';
	import { t, type Locale } from '$lib/i18n/index.js';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import Seo from '$lib/components/Seo.svelte';
	import * as Card from '$lib/components/ui/card';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { relativeTime } from '$lib/utils/time';
	import { invalidateAll } from '$app/navigation';
	import { toast } from 'svelte-sonner';
	import { untrack } from 'svelte';
	import PageContainer from '$lib/components/PageContainer.svelte';
	import { resolveTone, TONE_TEXT_CLASS, PULSE_DOT_CLASS, badgeLabel } from '$lib/config/status-badges';

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

	type WebhookDelivery = {
		id: number;
		webhookId: string;
		eventType: string;
		attempts: number;
		maxAttempts: number;
		status: 'pending' | 'delivered' | 'dead';
		lastError: string | null;
		nextAttemptAt: string | Date;
		createdAt: string | Date;
	};

	type PageData = {
		notifications: Notification[];
		webhooks: { url?: string };
		deliveries: WebhookDelivery[];
		isAdmin?: boolean;
	};

	let { data }: { data: PageData } = $props();
	const isAdmin = $derived(data.isAdmin ?? true);
	const locale = $derived($page.data.locale as Locale);
	let webhookUrl = $state(untrack(() => data.webhooks.url ?? ''));
	let savingWebhook = $state(false);
	let retrying = $state<Record<number, boolean>>({});

	async function retryDelivery(id: number) {
		retrying[id] = true;
		try {
			const res = await fetch(`/api/webhooks/deliveries/${id}/retry`, { method: 'POST' });
			if (!res.ok) toast.error(res.status === 403 ? t(locale, 'notifications.error-admin-required') : t(locale, 'notifications.error-retry-failed'));
			else {
				toast.success(t(locale, 'notifications.toast-requeued'));
				await invalidateAll();
			}
		} finally {
			retrying[id] = false;
		}
	}

	async function markAllRead() {
		const res = await fetch('/api/notifications', { method: 'POST' });
		if (!res.ok) toast.error(t(locale, 'notifications.error-mark-read-failed'));
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
			if (!res.ok) toast.error(res.status === 403 ? t(locale, 'notifications.error-admin-required') : t(locale, 'notifications.error-save-failed'));
			else toast.success(t(locale, 'notifications.toast-webhook-saved'));
		} finally {
			savingWebhook = false;
		}
	}
</script>

<PageContainer size="default">
<Seo title={t(locale, 'notifications.seo-title')} description={t(locale, 'notifications.seo-description')} />

<PageHeader title={t(locale, 'notifications.title')} description={t(locale, 'notifications.header-description')}>
	{#snippet actions()}
		<Button variant="outline" onclick={markAllRead}>{t(locale, 'notifications.mark-all-read')}</Button>
	{/snippet}
</PageHeader>

<div class="grid grid-cols-1 lg:grid-cols-3 gap-4 mt-4">
	<div class="lg:col-span-2 flex flex-col gap-2">
		{#if data.notifications.length === 0}
			<p class="text-sm text-muted-foreground">{t(locale, 'notifications.empty')}</p>
		{/if}
		{#each data.notifications as n (n.id)}
			<Card.Root size="sm">
				<Card.Content class="py-3">
					<div class="flex items-start gap-3">
						<span
							class="mt-1 inline-block size-2 rounded-full {n.readAt
								? 'bg-muted-foreground/40'
								: PULSE_DOT_CLASS.sky}"
						></span>
						<div class="min-w-0 flex-1">
							<p class="text-sm font-medium {TONE_TEXT_CLASS[resolveTone('alert-severity', n.severity)]}">{n.title}</p>
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
				<Card.Title class="text-base">{t(locale, 'notifications.webhook-title')}</Card.Title>
			</Card.Header>
			<Card.Content class="flex flex-col gap-3">
				<p class="text-xs text-muted-foreground">
					{t(locale, 'notifications.webhook-description')}
				</p>
				<Input bind:value={webhookUrl} placeholder={t(locale, 'notifications.webhook-url-placeholder')} disabled={!isAdmin} />
				{#if isAdmin}
					<Button onclick={saveWebhook} disabled={savingWebhook}>{t(locale, 'notifications.save-button')}</Button>
				{/if}
			</Card.Content>
		</Card.Root>

		<Card.Root size="sm" class="mt-4">
			<Card.Header>
				<Card.Title class="text-base">{t(locale, 'notifications.deliveries-title')}</Card.Title>
			</Card.Header>
			<Card.Content class="flex flex-col gap-2">
				{#if data.deliveries.length === 0}
					<p class="text-xs text-muted-foreground">{t(locale, 'notifications.deliveries-empty')}</p>
				{:else}
					<div class="flex flex-col divide-y divide-border/60">
						{#each data.deliveries as d (d.id)}
							<div class="py-2 flex items-start gap-2 text-xs">
								<div class="min-w-0 flex-1">
									<p class="font-medium {TONE_TEXT_CLASS[resolveTone('webhook-delivery-status', d.status)]}">
										{badgeLabel(locale, 'webhook-delivery-status', d.status)} · <span class="font-mono">{d.eventType}</span>
									</p>
									<p class="text-muted-foreground/80 mt-0.5">
										{t(locale, 'notifications.delivery-attempt', { attempts: d.attempts, maxAttempts: d.maxAttempts })} · {relativeTime(d.createdAt)}
									</p>
									{#if d.lastError}
										<p class="{TONE_TEXT_CLASS.rose} mt-0.5 truncate" title={d.lastError}>
											{d.lastError}
										</p>
									{/if}
								</div>
								{#if d.status === 'dead' && isAdmin}
									<Button
										size="sm"
										variant="outline"
										disabled={retrying[d.id]}
										onclick={() => retryDelivery(d.id)}
									>
										{t(locale, 'notifications.retry-button')}
									</Button>
								{/if}
							</div>
						{/each}
					</div>
				{/if}
			</Card.Content>
		</Card.Root>
	</div>
</div>
</PageContainer>
