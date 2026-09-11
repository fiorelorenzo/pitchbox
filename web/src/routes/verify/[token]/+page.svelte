<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import { t, type Locale } from '$lib/i18n/index.js';
	import { Button } from '$lib/components/ui/button';
	import PageContainer from '$lib/components/PageContainer.svelte';
	import { toast } from 'svelte-sonner';
	import Seo from '$lib/components/Seo.svelte';

	let { data }: { data: { authOn: boolean; token: string } } = $props();
	const locale = $derived($page.data.locale as Locale);

	let busy = $state(false);
	let verified = $state(false);
	let failed = $state(false);

	// Consumption only happens on an explicit click, never on the page's own
	// `load` (same reasoning as /invite/[token]: a plain GET can be triggered
	// by something other than the recipient - an attacker-embedded image, a
	// mail client prefetching links - and this token is single-use).
	async function verify() {
		if (busy) return;
		busy = true;
		try {
			const res = await fetch('/api/auth/verify/confirm', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ token: data.token }),
			});
			if (res.ok) {
				verified = true;
				toast.success(t(locale, 'verify.toast-verified-title'), {
					description: t(locale, 'verify.toast-verified-body'),
				});
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
			failed = true;
			toast.error(t(locale, 'verify.toast-failed-title'), {
				description: t(locale, 'verify.toast-failed-body'),
			});
		} finally {
			busy = false;
		}
	}
</script>

<Seo title={t(locale, 'verify.seo-title')} description={t(locale, 'verify.seo-description')} />

<PageContainer size="narrow" class="text-center">
	{#if verified}
		<h1 class="text-xl font-semibold">{t(locale, 'verify.verified-title')}</h1>
		<p class="mt-2 text-muted-foreground">{t(locale, 'verify.verified-body')}</p>
		<Button class="mt-6" onclick={() => goto('/')}>{t(locale, 'verify.go-to-dashboard')}</Button>
	{:else if failed}
		<h1 class="text-xl font-semibold">{t(locale, 'verify.failed-title')}</h1>
		<p class="mt-2 text-muted-foreground">
			{t(locale, 'verify.failed-body')}
		</p>
	{:else}
		<h1 class="text-xl font-semibold">{t(locale, 'verify.title')}</h1>
		<p class="mt-2 text-muted-foreground">{t(locale, 'verify.body')}</p>
		<Button class="mt-6" onclick={verify} disabled={busy}>
			{busy ? t(locale, 'verify.verifying-button') : t(locale, 'verify.verify-button')}
		</Button>
	{/if}
</PageContainer>
