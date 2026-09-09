<script lang="ts">
	import { goto } from '$app/navigation';
	import { Button } from '$lib/components/ui/button';
	import PageContainer from '$lib/components/PageContainer.svelte';
	import { toast } from 'svelte-sonner';
	import Seo from '$lib/components/Seo.svelte';

	let { data }: { data: { authOn: boolean; token: string } } = $props();

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
				toast.success('Email verified', {
					description: 'You can now start runs on this account.',
				});
				return;
			}
			if (res.status === 429) {
				const body = (await res.json()) as { retry_after_seconds?: number };
				toast.error('Too many attempts', {
					description: body.retry_after_seconds
						? `Try again in ${body.retry_after_seconds}s`
						: undefined,
				});
				return;
			}
			failed = true;
			toast.error('This link is no longer valid', {
				description: 'It may have expired or already been used - request a new one from Settings.',
			});
		} finally {
			busy = false;
		}
	}
</script>

<Seo title="Verify email - Pitchbox" description="Verify your Pitchbox account email address." />

<PageContainer size="narrow" class="text-center">
	{#if verified}
		<h1 class="text-xl font-semibold">Email verified</h1>
		<p class="mt-2 text-muted-foreground">Your account can now start runs.</p>
		<Button class="mt-6" onclick={() => goto('/')}>Go to dashboard</Button>
	{:else if failed}
		<h1 class="text-xl font-semibold">Link no longer valid</h1>
		<p class="mt-2 text-muted-foreground">
			It may have expired or already been used. Request a new link from Settings.
		</p>
	{:else}
		<h1 class="text-xl font-semibold">Verify your email</h1>
		<p class="mt-2 text-muted-foreground">Confirm this address to start running campaigns.</p>
		<Button class="mt-6" onclick={verify} disabled={busy}>
			{busy ? 'Verifying…' : 'Verify email'}
		</Button>
	{/if}
</PageContainer>
