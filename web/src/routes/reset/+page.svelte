<script lang="ts">
	import { page } from '$app/stores';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import * as Card from '$lib/components/ui/card';
	import { toast } from 'svelte-sonner';
	import Seo from '$lib/components/Seo.svelte';
	import { TONE_TEXT_CLASS } from '$lib/config/status-badges';
	import { t, type Locale } from '$lib/i18n/index.js';

	let { data }: { data: { authOn: boolean } } = $props();

	const locale = $derived($page.data.locale as Locale);

	let email = $state('');
	let busy = $state(false);
	let sent = $state(false);

	async function submit() {
		if (busy || !email) return;
		busy = true;
		try {
			const res = await fetch('/api/auth/password/forgot', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ email }),
			});
			if (res.status === 429) {
				const body = (await res.json()) as { retry_after_seconds?: number };
				toast.error(t(locale, 'reset.error-too-many-attempts'), {
					description: body.retry_after_seconds
						? t(locale, 'reset.error-retry-in', { seconds: body.retry_after_seconds })
						: undefined,
				});
				return;
			}
			if (!res.ok) {
				toast.error(t(locale, 'reset.error-send-failed'));
				return;
			}
			// #509: the response is identical whether or not the address has an
			// account, so the confirmation below never varies with `res` beyond
			// the ok/429/error branches above - a different message here would
			// itself leak which case ran.
			sent = true;
		} finally {
			busy = false;
		}
	}
</script>

<Seo
	title={data.authOn ? t(locale, 'reset.seo-title') : t(locale, 'auth.disabled-seo-title')}
	description={t(locale, 'reset.seo-description')}
/>

<div class="min-h-screen flex items-center justify-center bg-background p-6">
	<Card.Root class="w-full max-w-sm">
		{#if !data.authOn}
			<Card.Header>
				<Card.Title>{t(locale, 'auth.disabled-title')}</Card.Title>
				<p class="text-xs {TONE_TEXT_CLASS.amber}">
					{t(locale, 'reset.disabled-body')}
				</p>
			</Card.Header>
			<Card.Content>
				<Button href="/" variant="outline" class="w-full">{t(locale, 'auth.go-to-app')}</Button>
			</Card.Content>
		{:else if sent}
			<Card.Header>
				<Card.Title>{t(locale, 'reset.sent-title')}</Card.Title>
				<Card.Description>
					{t(locale, 'reset.sent-body')}
				</Card.Description>
			</Card.Header>
			<Card.Content>
				<Button href="/login" variant="outline" class="w-full"
					>{t(locale, 'reset.back-to-sign-in')}</Button
				>
			</Card.Content>
		{:else}
			<Card.Header>
				<Card.Title>{t(locale, 'reset.title')}</Card.Title>
				<Card.Description>
					{t(locale, 'reset.body')}
				</Card.Description>
			</Card.Header>
			<Card.Content class="flex flex-col gap-3">
				<label class="flex flex-col gap-1 text-xs">
					{t(locale, 'reset.email-label')}
					<Input type="email" bind:value={email} autocomplete="email" />
				</label>
				<Button onclick={submit} disabled={busy || !email}>
					{busy ? t(locale, 'reset.sending-button') : t(locale, 'reset.send-button')}
				</Button>
				<p class="text-center text-xs text-muted-foreground">
					<a href="/login" class="underline">{t(locale, 'reset.back-to-sign-in')}</a>
				</p>
			</Card.Content>
		{/if}
	</Card.Root>
</div>
