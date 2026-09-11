<script lang="ts">
	import * as Card from '$lib/components/ui/card';
	import { Button } from '$lib/components/ui/button';
	import { Badge } from '$lib/components/ui/badge';
	import { Progress } from '$lib/components/ui/progress';
	import { page } from '$app/stores';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import Seo from '$lib/components/Seo.svelte';
	import { toast } from 'svelte-sonner';
	import { AlertTriangle, Ban, ExternalLink } from '@lucide/svelte';
	import { TONE_BANNER_CLASS } from '$lib/config/status-badges';
	import type { PageData } from './$types';
	import type { UsageMetric } from '@pitchbox/shared/usage';
	import { t, type Locale } from '$lib/i18n/index.js';

	let { data }: { data: PageData } = $props();
	const locale = $derived($page.data.locale as Locale);

	function money(dollars: number): string {
		return dollars.toLocaleString(undefined, { style: 'currency', currency: 'USD' });
	}

	function moneyCents(cents: number): string {
		return money(cents / 100);
	}

	// Locale-independent so SSR and the client render the same string,
	// matching BillingGraceBanner's own convention for the same date.
	function formatDate(iso: string): string {
		return new Date(iso).toDateString();
	}

	// A Stripe session response body, narrowed without an inline cast: after
	// the `in` check TypeScript already knows `body.url` is `unknown`, so the
	// final `typeof` check is what actually proves it is a string.
	function sessionUrl(body: unknown): string | null {
		if (body && typeof body === 'object' && 'url' in body && typeof body.url === 'string') {
			return body.url;
		}
		return null;
	}

	const isGrant = $derived(!data.selfHost && data.source === 'grant');
	const isFree = $derived(!data.selfHost && data.source === 'default' && data.planId === 'free');
	const isSubscription = $derived(!data.selfHost && data.source === 'subscription');

	let checkoutBusy = $state<string | null>(null);
	async function startCheckout(planId: string, interval: 'month' | 'year') {
		if (checkoutBusy) return;
		checkoutBusy = `${planId}:${interval}`;
		try {
			const res = await fetch('/api/billing/checkout', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ plan: planId, interval }),
			});
			if (!res.ok) {
				toast.error(t(locale, 'settings.billing.error-checkout-failed'));
				return;
			}
			const url = sessionUrl(await res.json());
			if (!url) {
				toast.error(t(locale, 'settings.billing.error-checkout-failed'));
				return;
			}
			window.location.href = url;
		} catch {
			toast.error(t(locale, 'settings.billing.error-checkout-failed'));
		} finally {
			checkoutBusy = null;
		}
	}

	let portalBusy = $state(false);
	async function openPortal() {
		if (portalBusy) return;
		portalBusy = true;
		try {
			const res = await fetch('/api/billing/portal', { method: 'POST' });
			if (!res.ok) {
				toast.error(t(locale, 'settings.billing.error-portal-failed'));
				return;
			}
			const url = sessionUrl(await res.json());
			if (!url) {
				toast.error(t(locale, 'settings.billing.error-portal-failed'));
				return;
			}
			window.location.href = url;
		} catch {
			toast.error(t(locale, 'settings.billing.error-portal-failed'));
		} finally {
			portalBusy = false;
		}
	}
</script>

{#snippet usageRow(label: string, metric: UsageMetric)}
	<div class="grid gap-1.5">
		<div class="flex items-baseline justify-between text-sm">
			<span class="font-medium">{label}</span>
			{#if metric.limit == null}
				<span class="text-muted-foreground">{t(locale, 'settings.billing.unlimited')}</span>
			{:else}
				<span class="tabular-nums text-muted-foreground">{metric.used} / {metric.limit}</span>
			{/if}
		</div>
		{#if metric.limit != null}
			<Progress
				value={metric.limit > 0 ? Math.min(100, (metric.used / metric.limit) * 100) : 100}
				aria-label={label}
			/>
		{/if}
	</div>
{/snippet}

<Seo
	title={t(locale, 'settings.billing.seo-title')}
	description={t(locale, 'settings.billing.seo-description')}
/>

<PageHeader
	title={t(locale, 'settings.billing.title')}
	description={t(locale, 'settings.billing.description')}
/>

<div class="flex flex-col gap-6">
	{#if data.selfHost}
		<Card.Root>
			<Card.Header>
				<Card.Title>{t(locale, 'settings.billing.self-hosted-title')}</Card.Title>
				<Card.Description>
					{t(locale, 'settings.billing.self-hosted-description')}
				</Card.Description>
			</Card.Header>
		</Card.Root>
	{:else}
		{#if data.graceEndsAt}
			<div
				role="alert"
				class="flex items-start gap-2 rounded-lg border {data.readOnly
					? TONE_BANNER_CLASS.rose
					: TONE_BANNER_CLASS.amber}"
			>
				{#if data.readOnly}
					<Ban class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
				{:else}
					<AlertTriangle class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
				{/if}
				<div class="flex-1">
					{#if data.readOnly}
						<div class="font-medium">
							{t(locale, 'settings.billing.read-only-since', { date: formatDate(data.graceEndsAt) })}
						</div>
						<div class="text-xs opacity-85">
							{t(locale, 'settings.billing.read-only-description')}
						</div>
					{:else}
						<div class="font-medium">
							{t(locale, 'settings.billing.grace-period-until', { date: formatDate(data.graceEndsAt) })}
						</div>
						<div class="text-xs opacity-85">
							{t(locale, 'settings.billing.grace-period-description', {
								date: formatDate(data.graceEndsAt),
							})}
						</div>
					{/if}
				</div>
			</div>
		{/if}

		<Card.Root>
			<Card.Header>
				<div class="flex items-center gap-2">
					<Card.Title>{data.planName}</Card.Title>
					{#if data.status}
						<Badge variant={data.status === 'active' ? 'secondary' : 'outline'}>{data.status}</Badge>
					{/if}
					{#if isGrant}
						<Badge variant="outline">{t(locale, 'settings.billing.granted-badge')}</Badge>
					{/if}
				</div>
				<Card.Description>
					{#if isGrant}
						{t(locale, 'settings.billing.granted-description')}
					{:else if isFree}
						{t(locale, 'settings.billing.free-description')}
					{:else if data.priceCents != null && data.interval}
						{moneyCents(data.priceCents)} / {data.interval} ·
						{data.cancelAtPeriodEnd
							? t(locale, 'settings.billing.cancels-on', {
									date: formatDate(data.currentPeriodEnd ?? ''),
								})
							: t(locale, 'settings.billing.renews-on', {
									date: formatDate(data.currentPeriodEnd ?? ''),
								})}{#if data.pendingPlanName && data.pendingPlanEffectiveAt}{' · ' +
								t(locale, 'settings.billing.switches-to', {
									plan: data.pendingPlanName,
									date: formatDate(data.pendingPlanEffectiveAt),
								})}{/if}
					{/if}
				</Card.Description>
			</Card.Header>
			<Card.Content>
				{#if isFree}
					<div class="grid gap-3 sm:grid-cols-3">
						{#each data.pickablePlans as plan (plan.id)}
							<div class="rounded-lg border p-3">
								<div class="font-medium">{plan.name}</div>
								<div class="mt-1 text-sm text-muted-foreground">
								{moneyCents(plan.monthlyPriceCents)}
								{t(locale, 'settings.billing.per-month')}
								{t(locale, 'settings.billing.or')}
								{moneyCents(plan.annualPriceCents)}
								{t(locale, 'settings.billing.per-year')}
								</div>
								<div class="mt-3 flex gap-2">
									<Button
										size="sm"
										variant="outline"
										loading={checkoutBusy === `${plan.id}:month`}
										onclick={() => startCheckout(plan.id, 'month')}
									>
									{t(locale, 'settings.billing.monthly')}
									</Button>
									<Button
										size="sm"
										loading={checkoutBusy === `${plan.id}:year`}
										onclick={() => startCheckout(plan.id, 'year')}
									>
									{t(locale, 'settings.billing.yearly')}
									</Button>
								</div>
							</div>
						{/each}
					</div>
				{:else if isSubscription && data.hasStripeCustomer}
					<Button loading={portalBusy} onclick={openPortal}>
						{t(locale, 'settings.billing.open-customer-portal')}
						<ExternalLink class="size-3.5" />
					</Button>
					<p class="mt-2 text-xs text-muted-foreground">
						{t(locale, 'settings.billing.portal-note')}
					</p>
				{/if}
			</Card.Content>
		</Card.Root>

		<Card.Root>
			<Card.Header>
				<Card.Title>{t(locale, 'settings.billing.usage-title')}</Card.Title>
				<Card.Description>
					{t(locale, 'settings.billing.usage-description')}
				</Card.Description>
			</Card.Header>
			<Card.Content class="grid gap-4">
				{@render usageRow(t(locale, 'settings.billing.metric-runs'), data.usage.runs)}
				{@render usageRow(t(locale, 'settings.billing.metric-suggestions'), data.usage.suggestions)}
				{@render usageRow(t(locale, 'settings.billing.metric-projects'), data.usage.projects)}
				{@render usageRow(t(locale, 'settings.billing.metric-accounts'), data.usage.accounts)}
				{@render usageRow(t(locale, 'settings.billing.metric-seats'), data.usage.seats)}
				{@render usageRow(t(locale, 'settings.billing.metric-devices'), data.usage.extensionDevices)}

				<div class="grid gap-1.5 border-t pt-4">
					<div class="flex items-baseline justify-between text-sm">
						<span class="font-medium">{t(locale, 'settings.billing.model-allowance-label')}</span>
						<span class="tabular-nums text-muted-foreground">
							{data.usage.modelAllowance.usedPercent == null
								? t(locale, 'settings.billing.unlimited')
								: `${data.usage.modelAllowance.usedPercent}%`}
						</span>
					</div>
					<p class="text-xs text-muted-foreground">
						{t(locale, 'settings.billing.model-allowance-description')}
					</p>
					{#if data.usage.modelAllowance.usedPercent != null}
						<Progress
							value={Math.min(100, Math.max(0, data.usage.modelAllowance.usedPercent))}
							aria-label={t(locale, 'settings.billing.model-allowance-label')}
						/>
					{/if}
				</div>
			</Card.Content>
		</Card.Root>
	{/if}
</div>
