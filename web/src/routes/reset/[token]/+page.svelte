<script lang="ts">
	import { goto } from '$app/navigation';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import * as Card from '$lib/components/ui/card';
	import { toast } from 'svelte-sonner';
	import Seo from '$lib/components/Seo.svelte';
	import { TONE_TEXT_CLASS } from '$lib/config/status-badges';

	let { data }: { data: { authOn: boolean; token: string } } = $props();

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
				toast.success('Password reset', {
					description: 'Every other session on your account was signed out.',
				});
				await goto('/', { invalidateAll: true });
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
			toast.error('This link is no longer valid', {
				description: 'It may have expired or already been used - request a new one.',
			});
		} finally {
			busy = false;
		}
	}
</script>

<Seo
	title={data.authOn ? 'Choose a new password' : 'Authentication disabled'}
	description="Choose a new Pitchbox password"
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
		{:else}
			<Card.Header>
				<Card.Title>Choose a new password</Card.Title>
				<Card.Description>
					At least 8 characters. This signs you in and signs out every other session on
					this account.
				</Card.Description>
			</Card.Header>
			<Card.Content class="flex flex-col gap-3">
				<label class="flex flex-col gap-1 text-xs">
					New password
					<Input
						type="password"
						bind:value={newPassword}
						disabled={busy}
						autocomplete="new-password"
					/>
				</label>
				<label class="flex flex-col gap-1 text-xs">
					Confirm new password
					<Input
						type="password"
						bind:value={confirmPassword}
						disabled={busy}
						autocomplete="new-password"
					/>
				</label>
				<Button onclick={submit} disabled={!canSubmit}>
					{busy ? 'Resetting…' : 'Reset password'}
				</Button>
			</Card.Content>
		{/if}
	</Card.Root>
</div>
