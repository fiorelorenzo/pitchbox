<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import * as Card from '$lib/components/ui/card';
	import { toast } from 'svelte-sonner';
	import Seo from '$lib/components/Seo.svelte';
	import { TONE_TEXT_CLASS } from '$lib/config/status-badges';

	let { data }: { data: { authOn: boolean } } = $props();

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
				toast.error('Too many attempts', {
					description: body.retry_after_seconds
						? `Try again in ${body.retry_after_seconds}s`
						: undefined,
				});
				return;
			}
			if (!res.ok) {
				toast.error('Could not send reset link');
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
	title={data.authOn ? 'Reset your password' : 'Authentication disabled'}
	description="Request a password reset link"
/>

<div class="min-h-screen flex items-center justify-center bg-background p-6">
	<Card.Root class="w-full max-w-sm">
		{#if !data.authOn}
			<Card.Header>
				<Card.Title>Authentication is disabled</Card.Title>
				<p class="text-xs {TONE_TEXT_CLASS.amber}">
					This instance runs with PITCHBOX_AUTH off, so there is no account to reset a
					password for. Set PITCHBOX_AUTH=on in your environment to enable this.
				</p>
			</Card.Header>
			<Card.Content>
				<Button href="/" variant="outline" class="w-full">Go to Pitchbox</Button>
			</Card.Content>
		{:else if sent}
			<Card.Header>
				<Card.Title>Check your email</Card.Title>
				<Card.Description>
					If that address has a Pitchbox account, a reset link is on its way. It expires in
					20 minutes.
				</Card.Description>
			</Card.Header>
			<Card.Content>
				<Button href="/login" variant="outline" class="w-full">Back to sign in</Button>
			</Card.Content>
		{:else}
			<Card.Header>
				<Card.Title>Reset your password</Card.Title>
				<Card.Description>
					Enter the email on your account and we'll send you a link to choose a new
					password.
				</Card.Description>
			</Card.Header>
			<Card.Content class="flex flex-col gap-3">
				<label class="flex flex-col gap-1 text-xs">
					Email
					<Input type="email" bind:value={email} autocomplete="email" />
				</label>
				<Button onclick={submit} disabled={busy || !email}>
					{busy ? 'Sending…' : 'Send reset link'}
				</Button>
				<p class="text-center text-xs text-muted-foreground">
					<a href="/login" class="underline">Back to sign in</a>
				</p>
			</Card.Content>
		{/if}
	</Card.Root>
</div>
