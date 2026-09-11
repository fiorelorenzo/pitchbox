<script lang="ts">
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import * as Card from '$lib/components/ui/card';
	import { toast } from 'svelte-sonner';
	import Seo from '$lib/components/Seo.svelte';
	import { TONE_TEXT_CLASS } from '$lib/config/status-badges';
	import { t, type Locale } from '$lib/i18n/index.js';

	let { data }: { data: { authOn: boolean; token: string } } = $props();

	const locale = $derived($page.data.locale as Locale);

	let newPassword = $state('');
	let confirmPassword = $state('');
	let busy = $state(false);

	const canSubmit = $derived(
		!busy && newPassword.length >= 8 && newPassword === confirmPassword,
	);

	async function submit() {
		if (!canSubmit) return;
		busy = true;
		try {
			const res = await fetch('/api/auth/password/reset', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ token: data.token, newPassword }),
			});
			if (res.ok) {
				toast.success(t(locale, 'reset.confirm.success-title'), {
					description: t(locale, 'reset.confirm.success-body'),
				});
				await goto('/', { invalidateAll: true });
				return;
			}
			if (res.status === 429) {
				const body = (await res.json()) as { retry_after_seconds?: number };
				toast.error(t(locale, 'reset.error-too-many-attempts'), {
					description: body.retry_after_seconds
						? t(locale, 'reset.error-retry-in', { seconds: body.retry_after_seconds })
						: undefined,
				});
				return;
			}
			toast.error(t(locale, 'reset.confirm.error-invalid-title'), {
				description: t(locale, 'reset.confirm.error-invalid-body'),
			});
		} finally {
			busy = false;
		}
	}
</script>

<Seo
	title={data.authOn ? t(locale, 'reset.confirm.seo-title') : t(locale, 'auth.disabled-seo-title')}
	description={t(locale, 'reset.confirm.seo-description')}
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
		{:else}
			<Card.Header>
				<Card.Title>{t(locale, 'reset.confirm.title')}</Card.Title>
				<Card.Description>
					{t(locale, 'reset.confirm.body')}
				</Card.Description>
			</Card.Header>
			<Card.Content class="flex flex-col gap-3">
				<label class="flex flex-col gap-1 text-xs">
					{t(locale, 'reset.confirm.new-password-label')}
					<Input
						type="password"
						bind:value={newPassword}
						disabled={busy}
						autocomplete="new-password"
					/>
				</label>
				<label class="flex flex-col gap-1 text-xs">
					{t(locale, 'reset.confirm.confirm-password-label')}
					<Input
						type="password"
						bind:value={confirmPassword}
						disabled={busy}
						autocomplete="new-password"
					/>
				</label>
				<Button onclick={submit} disabled={!canSubmit}>
					{busy ? t(locale, 'reset.confirm.submitting-button') : t(locale, 'reset.confirm.submit-button')}
				</Button>
			</Card.Content>
		{/if}
	</Card.Root>
</div>
