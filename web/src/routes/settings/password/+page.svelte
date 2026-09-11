<script lang="ts">
	import * as Card from '$lib/components/ui/card';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { page } from '$app/stores';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import Seo from '$lib/components/Seo.svelte';
	import { toast } from 'svelte-sonner';
	import { t, type Locale } from '$lib/i18n/index.js';

	type PageData = { username: string; email: string | null; emailVerified: boolean };
	let { data }: { data: PageData } = $props();
	const locale = $derived($page.data.locale as Locale);

	let currentPassword = $state('');
	let newPassword = $state('');
	let confirmPassword = $state('');
	let busy = $state(false);
	let resendBusy = $state(false);

	const canSubmit = $derived(
		!busy &&
			currentPassword.length > 0 &&
			newPassword.length >= 8 &&
			newPassword === confirmPassword,
	);

	async function submit() {
		if (!canSubmit) return;
		busy = true;
		try {
			const res = await fetch('/api/auth/password', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ currentPassword, newPassword }),
			});
			if (res.ok) {
				toast.success(t(locale, 'settings.password.success-changed'), {
					description: t(locale, 'settings.password.success-changed-description'),
				});
				currentPassword = '';
				newPassword = '';
				confirmPassword = '';
				return;
			}
			if (res.status === 401) {
				toast.error(t(locale, 'settings.password.error-incorrect'));
				return;
			}
			if (res.status === 429) {
				const body = (await res.json()) as { retry_after_seconds?: number };
				toast.error(t(locale, 'settings.password.error-too-many-attempts'), {
					description: body.retry_after_seconds
						? t(locale, 'settings.password.error-retry-after', { n: body.retry_after_seconds })
						: undefined,
				});
				return;
			}
			toast.error(t(locale, 'settings.password.error-change-failed'), { description: await res.text() });
		} finally {
			busy = false;
		}
	}

	async function resendVerification() {
		if (resendBusy) return;
		resendBusy = true;
		try {
			const res = await fetch('/api/auth/verify/resend', { method: 'POST' });
			if (res.ok) {
				const body = (await res.json()) as { alreadyVerified?: boolean };
				toast.success(
					body.alreadyVerified
						? t(locale, 'settings.password.verify-already-verified')
						: t(locale, 'settings.password.verify-sent'),
					{
						description: body.alreadyVerified
							? undefined
							: t(locale, 'settings.password.verify-sent-description', { email: data.email ?? '' }),
					},
				);
				return;
			}
			if (res.status === 429) {
				const body = (await res.json()) as { retry_after_seconds?: number };
				toast.error(t(locale, 'settings.password.error-too-many-attempts'), {
					description: body.retry_after_seconds
						? t(locale, 'settings.password.error-retry-after', { n: body.retry_after_seconds })
						: undefined,
				});
				return;
			}
			toast.error(t(locale, 'settings.password.error-resend-failed'));
		} finally {
			resendBusy = false;
		}
	}
</script>

<Seo
	title={t(locale, 'settings.password.seo-title')}
	description={t(locale, 'settings.password.seo-description')}
/>

<PageHeader
	title={t(locale, 'settings.password.title')}
	description={t(locale, 'settings.password.description', { username: data.username })}
/>

<div class="grid gap-4">
	{#if data.email}
		<Card.Root>
			<Card.Header>
				<Card.Title class="flex items-center gap-2">
					{t(locale, 'settings.password.email-verification-title')}
					{#if data.emailVerified}
						<Badge variant="secondary">{t(locale, 'settings.password.verified-badge')}</Badge>
					{:else}
						<Badge variant="destructive">{t(locale, 'settings.password.unverified-badge')}</Badge>
					{/if}
				</Card.Title>
				<Card.Description>
					{data.email}
					{#if !data.emailVerified}
						{t(locale, 'settings.password.unverified-note')}
					{/if}
				</Card.Description>
			</Card.Header>
			{#if !data.emailVerified}
				<Card.Content>
					<Button variant="outline" onclick={resendVerification} disabled={resendBusy}>
						{resendBusy
							? t(locale, 'settings.password.sending')
							: t(locale, 'settings.password.resend-verification')}
					</Button>
				</Card.Content>
			{/if}
		</Card.Root>
	{/if}
	<Card.Root>
		<Card.Header>
			<Card.Title>{t(locale, 'settings.password.change-title')}</Card.Title>
			<Card.Description>
				{t(locale, 'settings.password.change-description')}
			</Card.Description>
		</Card.Header>
		<Card.Content class="flex max-w-sm flex-col gap-3">
			<label class="flex flex-col gap-1 text-xs">
				{t(locale, 'settings.password.current-password')}
				<Input
					type="password"
					bind:value={currentPassword}
					disabled={busy}
					autocomplete="current-password"
				/>
			</label>
			<label class="flex flex-col gap-1 text-xs">
				{t(locale, 'settings.password.new-password')}
				<Input
					type="password"
					bind:value={newPassword}
					disabled={busy}
					autocomplete="new-password"
				/>
			</label>
			<label class="flex flex-col gap-1 text-xs">
				{t(locale, 'settings.password.confirm-password')}
				<Input
					type="password"
					bind:value={confirmPassword}
					disabled={busy}
					autocomplete="new-password"
				/>
			</label>
			<Button onclick={submit} disabled={!canSubmit}
				>{t(locale, 'settings.password.change-title')}</Button
			>
		</Card.Content>
	</Card.Root>
</div>
