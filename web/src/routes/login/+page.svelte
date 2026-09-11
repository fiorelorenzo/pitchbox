<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import * as Card from '$lib/components/ui/card';
	import { toast } from 'svelte-sonner';
	import Seo from '$lib/components/Seo.svelte';
	import { TONE_TEXT_CLASS } from '$lib/config/status-badges';
	import { t, type Locale } from '$lib/i18n/index.js';

	let { data }: { data: { authOn: boolean; firstUser: boolean } } = $props();

	const locale = $derived($page.data.locale as Locale);

	let username = $state('');
	let password = $state('');
	let busy = $state(false);

	async function submit() {
		if (busy) return;
		busy = true;
		try {
			const res = await fetch('/api/auth/login', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ username, password }),
			});
			if (!res.ok) {
				toast.error(
					data.firstUser
						? t(locale, 'login.error-create-failed')
						: t(locale, 'login.error-invalid-credentials'),
				);
				return;
			}
			const next = $page.url.searchParams.get('next') || '/';
			await goto(next, { invalidateAll: true });
		} finally {
			busy = false;
		}
	}
</script>

<Seo
	title={data.authOn ? t(locale, 'login.seo-title') : t(locale, 'auth.disabled-seo-title')}
	description={t(locale, 'login.seo-description')}
/>

<div class="min-h-screen flex items-center justify-center bg-background p-6">
	<Card.Root class="w-full max-w-sm">
		{#if !data.authOn}
			<Card.Header>
				<Card.Title>{t(locale, 'auth.disabled-title')}</Card.Title>
				<p class="text-xs {TONE_TEXT_CLASS.amber}">
					{t(locale, 'login.disabled-body')}
				</p>
			</Card.Header>
			<Card.Content>
				<Button href="/" variant="outline" class="w-full">{t(locale, 'auth.go-to-app')}</Button>
			</Card.Content>
		{:else}
			<Card.Header>
				<Card.Title
					>{data.firstUser
						? t(locale, 'login.create-first-user-title')
						: t(locale, 'login.sign-in-title')}</Card.Title
				>
				{#if data.firstUser}
					<p class="text-xs text-muted-foreground">
						{t(locale, 'login.first-user-hint')}
					</p>
				{/if}
			</Card.Header>
			<Card.Content class="flex flex-col gap-3">
				<label class="flex flex-col gap-1 text-xs">
					{t(locale, 'login.username-label')}
					<Input bind:value={username} autocomplete="username" />
				</label>
				<label class="flex flex-col gap-1 text-xs">
					{t(locale, 'login.password-label')}
					<Input type="password" bind:value={password} autocomplete="current-password" />
				</label>
				<Button onclick={submit} disabled={busy || !username || password.length < 8}>
					{data.firstUser ? t(locale, 'login.create-button') : t(locale, 'login.sign-in-button')}
				</Button>
			{#if !data.firstUser}
				<p class="text-center text-xs text-muted-foreground">
					{t(locale, 'login.need-account')} <a
						href={`/register?next=${encodeURIComponent($page.url.searchParams.get('next') || '/')}`}
						class="underline">{t(locale, 'login.create-account-link')}</a
					>
				</p>
				<p class="text-center text-xs text-muted-foreground">
					<a href="/reset" class="underline">{t(locale, 'login.forgot-password-link')}</a>
				</p>
			{/if}
			</Card.Content>
		{/if}
	</Card.Root>
</div>
