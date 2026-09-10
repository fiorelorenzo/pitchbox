<script lang="ts">
	import * as Card from '$lib/components/ui/card';
	import { Button } from '$lib/components/ui/button';
	import { Badge } from '$lib/components/ui/badge';
	import { Progress } from '$lib/components/ui/progress';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import Seo from '$lib/components/Seo.svelte';
	import PageContainer from '$lib/components/PageContainer.svelte';
	import { toast } from 'svelte-sonner';
	import { AlertTriangle, Ban, ExternalLink } from '@lucide/svelte';
	import { TONE_BANNER_CLASS } from '$lib/config/status-badges';
	import type { PageData } from './$types';
	import type { UsageMetric } from '@pitchbox/shared/usage';

	let { data }: { data: PageData } = $props();

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
				toast.error('Could not start checkout');
				return;
			}
			const url = sessionUrl(await res.json());
			if (!url) {
				toast.error('Could not start checkout');
				return;
			}
			window.location.href = url;
		} catch {
			toast.error('Could not start checkout');
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
				toast.error('Could not open the customer portal');
				return;
			}
			const url = sessionUrl(await res.json());
			if (!url) {
				toast.error('Could not open the customer portal');
				return;
			}
			window.location.href = url;
		} catch {
			toast.error('Could not open the customer portal');
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
				<span class="text-muted-foreground">Unlimited</span>
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

<PageContainer size="default">
	<Seo
		title="Settings - Billing"
		description="Your plan, what of it is used this period, and how to change it."
	/>

	<PageHeader
		title="Billing"
		description="The plan, what of it is used this period, and the two real ways to change it."
	/>

	{#if data.selfHost}
		<Card.Root class="mt-4">
			<Card.Header>
				<Card.Title>Self-hosted</Card.Title>
				<Card.Description>
					This deployment runs outside the cloud edition, so every limit is unlimited and there is
					nothing to bill. There is no plan to pick or portal to open here.
				</Card.Description>
			</Card.Header>
		</Card.Root>
	{:else}
		{#if data.graceEndsAt}
			<div
				role="alert"
				class="mt-4 flex items-start gap-2 rounded-lg border {data.readOnly
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
						<div class="font-medium">Account is read-only since {formatDate(data.graceEndsAt)}</div>
						<div class="text-xs opacity-85">
							A payment failed and nothing succeeded during the grace period. New runs,
							suggestions, accepts, projects, campaigns, invites and devices are refused until the
							payment method is fixed in the portal below.
						</div>
					{:else}
						<div class="font-medium">Payment failed - grace period until {formatDate(data.graceEndsAt)}</div>
						<div class="text-xs opacity-85">
							The plan keeps working normally until then. Update the payment method in the portal
							below before {formatDate(data.graceEndsAt)} to avoid going read-only.
						</div>
					{/if}
				</div>
			</div>
		{/if}

		<Card.Root class="mt-4">
			<Card.Header>
				<div class="flex items-center gap-2">
					<Card.Title>{data.planName}</Card.Title>
					{#if data.status}
						<Badge variant={data.status === 'active' ? 'secondary' : 'outline'}>{data.status}</Badge>
					{/if}
					{#if isGrant}
						<Badge variant="outline">Granted</Badge>
					{/if}
				</div>
				<Card.Description>
					{#if isGrant}
						This plan was granted by an instance admin. It is not billed through Stripe, and does
						not change from this page.
					{:else if isFree}
						No subscription. Free covers a single project on the house.
					{:else if data.priceCents != null && data.interval}
						{moneyCents(data.priceCents)} / {data.interval} · {data.cancelAtPeriodEnd
							? `cancels on ${formatDate(data.currentPeriodEnd ?? '')}`
							: `renews on ${formatDate(data.currentPeriodEnd ?? '')}`}
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
									{moneyCents(plan.monthlyPriceCents)} / month or {moneyCents(plan.annualPriceCents)} / year
								</div>
								<div class="mt-3 flex gap-2">
									<Button
										size="sm"
										variant="outline"
										loading={checkoutBusy === `${plan.id}:month`}
										onclick={() => startCheckout(plan.id, 'month')}
									>
										Monthly
									</Button>
									<Button
										size="sm"
										loading={checkoutBusy === `${plan.id}:year`}
										onclick={() => startCheckout(plan.id, 'year')}
									>
										Yearly
									</Button>
								</div>
							</div>
						{/each}
					</div>
				{:else if isSubscription && data.hasStripeCustomer}
					<Button loading={portalBusy} onclick={openPortal}>
						Open customer portal
						<ExternalLink class="size-3.5" />
					</Button>
					<p class="mt-2 text-xs text-muted-foreground">
						Change plan, update the payment method, or see invoices in the portal. Nothing here
						writes a plan directly - the portal and its webhook are the only path.
					</p>
				{/if}
			</Card.Content>
		</Card.Root>

		<Card.Root class="mt-4">
			<Card.Header>
				<Card.Title>Usage this period</Card.Title>
				<Card.Description>
					What the plan meters, measured against its limits. A metric the plan leaves unmetered
					says unlimited rather than a full bar.
				</Card.Description>
			</Card.Header>
			<Card.Content class="grid gap-4">
				{@render usageRow('Runs', data.usage.runs)}
				{@render usageRow('Suggestions', data.usage.suggestions)}
				{@render usageRow('Projects', data.usage.projects)}
				{@render usageRow('Connected accounts', data.usage.accounts)}
				{@render usageRow('Seats', data.usage.seats)}
				{@render usageRow('Paired devices', data.usage.extensionDevices)}

				<div class="grid gap-1.5 border-t pt-4">
					<div class="flex items-baseline justify-between text-sm">
						<span class="font-medium">Model allowance used</span>
						<span class="tabular-nums text-muted-foreground">
							{data.usage.modelAllowance.usedPercent == null
								? 'Unlimited'
								: `${data.usage.modelAllowance.usedPercent}%`}
						</span>
					</div>
					<p class="text-xs text-muted-foreground">
						How much of this period's model-spend allowance the org has used. Not an invoice
						line - the portal has those.
					</p>
					{#if data.usage.modelAllowance.usedPercent != null}
						<Progress
							value={Math.min(100, Math.max(0, data.usage.modelAllowance.usedPercent))}
							aria-label="Model allowance used"
						/>
					{/if}
				</div>
			</Card.Content>
		</Card.Root>
	{/if}
</PageContainer>
