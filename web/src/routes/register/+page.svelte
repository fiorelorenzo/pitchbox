<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import * as Card from '$lib/components/ui/card';
	import { toast } from 'svelte-sonner';
	import Seo from '$lib/components/Seo.svelte';
	import { TONE_TEXT_CLASS } from '$lib/config/status-badges';
	import { t, splitAroundToken, type Locale } from '$lib/i18n/index.js';

	type PageData = {
		authOn: boolean;
		next: string | null;
		invite: { token: string; email: string | null; orgName: string | null } | null;
		policy: 'open' | 'invite' | 'off';
		canRegister: boolean;
		selectedPlan: 'solo' | 'growth' | 'scale' | null;
		selectedInterval: 'month' | 'year' | null;
		selectedPlanName: string | null;
	};
	let { data }: { data: PageData } = $props();

	const locale = $derived($page.data.locale as Locale);

	let username = $state('');
	// svelte-ignore state_referenced_locally
	let email = $state(data.invite?.email ?? '');
	let password = $state('');
	let busy = $state(false);

	function signInHref(): string {
		return data.next ? `/login?next=${encodeURIComponent(data.next)}` : '/login';
	}

	async function submit() {
		if (busy) return;
		busy = true;
		try {
			const res = await fetch('/api/auth/register', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					username,
					email,
					password,
					token: data.invite?.token,
				}),
			});
		if (!res.ok) {
			const body = (await res.json().catch(() => ({}))) as {
				error?: string;
				message?: string;
			};
			const message =
				body.error === 'username_taken'
					? t(locale, 'register.error-username-taken')
					: body.error === 'email_taken'
						? t(locale, 'register.error-email-taken')
						: body.error === 'invalid_or_expired_invite'
							? t(locale, 'register.error-invite-invalid')
							: body.error === 'rate_limited'
								? t(locale, 'register.error-rate-limited')
								: (body.error === 'registration_closed' || body.error === 'invite_required') &&
									  body.message
									? body.message
									: t(locale, 'register.error-generic');
			toast.error(message);
			return;
		}
		const okBody = (await res.json().catch(() => ({}))) as { emailVerified?: boolean };
		if (!okBody.emailVerified) {
			toast.success(t(locale, 'register.success-title'), {
				description: t(locale, 'register.success-verify-body'),
			});
		}

			// #558: a signup that arrived via a pricing-page CTA (`/register?plan=growth`)
			// goes straight into Checkout for that plan rather than landing on an empty
			// dashboard - the whole point of the CTA carrying the plan through. Falls back
			// to the ordinary destination on any failure (self-host with billing off,
			// Stripe hiccup, a catalogue/Stripe price mismatch): a stalled checkout must
			// never strand the account that was just created for it.
			if (data.selectedPlan) {
				try {
					const checkoutRes = await fetch('/api/billing/checkout', {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({
							plan: data.selectedPlan,
							interval: data.selectedInterval ?? 'month',
						}),
					});
					if (checkoutRes.ok) {
						const { url } = (await checkoutRes.json()) as { url: string };
						window.location.href = url;
						return;
					}
				} catch {
					// falls through to the ordinary destination below
				}
			}
			await goto(data.next ?? '/', { invalidateAll: true });
		} finally {
			busy = false;
		}
	}
</script>

<Seo
	title={data.authOn ? t(locale, 'register.seo-title') : t(locale, 'auth.disabled-seo-title')}
	description={t(locale, 'register.seo-description')}
/>

<div class="min-h-screen flex items-center justify-center bg-background p-6">
	<Card.Root class="w-full max-w-sm">
		{#if !data.authOn}
			<Card.Header>
				<Card.Title>{t(locale, 'auth.disabled-title')}</Card.Title>
				<p class="text-xs {TONE_TEXT_CLASS.amber}">
					{t(locale, 'register.disabled-body')}
				</p>
			</Card.Header>
			<Card.Content>
				<Button href="/" variant="outline" class="w-full">{t(locale, 'auth.go-to-app')}</Button>
			</Card.Content>
		{:else if !data.canRegister}
			<Card.Header>
				<Card.Title>
					{data.policy === 'off'
						? t(locale, 'register.closed-title')
						: t(locale, 'register.invite-only-title')}
				</Card.Title>
				<p class="text-xs {TONE_TEXT_CLASS.amber}">
					{data.policy === 'off'
						? t(locale, 'register.closed-body')
						: t(locale, 'register.invite-only-body')}
				</p>
			</Card.Header>
			<Card.Content>
				<Button href={signInHref()} variant="outline" class="w-full"
					>{t(locale, 'register.sign-in-instead-button')}</Button
				>
			</Card.Content>
		{:else}
			<Card.Header>
				<Card.Title>{t(locale, 'register.title')}</Card.Title>
				{#if data.invite}
					{@const [before, after] = splitAroundToken(locale, 'register.invited-body', 'org')}
					<p class="text-xs text-muted-foreground">
						{before}<span class="font-medium text-foreground"
							>{data.invite.orgName ?? t(locale, 'register.default-org')}</span
						>{after}
					</p>
				{:else if data.selectedPlanName}
					{@const interval = t(
						locale,
						data.selectedInterval === 'year' ? 'register.billed-annually' : 'register.billed-monthly',
					)}
					{@const [before, after] = splitAroundToken(locale, 'register.plan-body', 'plan', {
						interval,
					})}
					<p class="text-xs text-muted-foreground">
						{before}<span class="font-medium text-foreground">{data.selectedPlanName}</span>{after}
					</p>
				{/if}
			</Card.Header>
			<Card.Content class="flex flex-col gap-3">
				<label class="flex flex-col gap-1 text-xs">
					{t(locale, 'login.username-label')}
					<Input bind:value={username} autocomplete="username" />
				</label>
				<label class="flex flex-col gap-1 text-xs">
					{t(locale, 'register.email-label')}
					<Input type="email" bind:value={email} autocomplete="email" />
				</label>
				<label class="flex flex-col gap-1 text-xs">
					{t(locale, 'login.password-label')}
					<Input type="password" bind:value={password} autocomplete="new-password" />
				</label>
				<Button onclick={submit} disabled={busy || !username || !email || password.length < 8}>
					{busy ? t(locale, 'register.creating-button') : t(locale, 'register.create-account-button')}
				</Button>
				<p class="text-center text-xs text-muted-foreground">
					{t(locale, 'register.already-have-account')}
					<a href={signInHref()} class="underline">{t(locale, 'register.sign-in-link')}</a>
				</p>
			</Card.Content>
		{/if}
	</Card.Root>
</div>
