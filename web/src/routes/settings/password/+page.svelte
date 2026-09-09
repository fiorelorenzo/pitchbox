<script lang="ts">
	import * as Card from '$lib/components/ui/card';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import Seo from '$lib/components/Seo.svelte';
	import PageContainer from '$lib/components/PageContainer.svelte';
	import { toast } from 'svelte-sonner';

	type PageData = { username: string; email: string | null; emailVerified: boolean };
	let { data }: { data: PageData } = $props();

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
				toast.success('Password changed', {
					description: 'Every other session on your account was signed out.',
				});
				currentPassword = '';
				newPassword = '';
				confirmPassword = '';
				return;
			}
			if (res.status === 401) {
				toast.error('Current password is incorrect');
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
			toast.error('Could not change password', { description: await res.text() });
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
				toast.success(body.alreadyVerified ? 'Already verified' : 'Verification email sent', {
					description: body.alreadyVerified ? undefined : `Check ${data.email}.`,
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
			toast.error('Could not resend verification email');
		} finally {
			resendBusy = false;
		}
	}
</script>

<PageContainer size="default">
<Seo title="Settings - Password" description="Change your account password." />

<PageHeader title="Password" description={`Change the password for ${data.username}.`} />

<div class="mt-4 grid gap-4">
	{#if data.email}
		<Card.Root>
			<Card.Header>
				<Card.Title class="flex items-center gap-2">
					Email verification
					{#if data.emailVerified}
						<Badge variant="secondary">Verified</Badge>
					{:else}
						<Badge variant="destructive">Unverified</Badge>
					{/if}
				</Card.Title>
				<Card.Description>
					{data.email}
					{#if !data.emailVerified}
						- an unverified account can sign in but can't start a run yet.
					{/if}
				</Card.Description>
			</Card.Header>
			{#if !data.emailVerified}
				<Card.Content>
					<Button variant="outline" onclick={resendVerification} disabled={resendBusy}>
						{resendBusy ? 'Sending…' : 'Resend verification email'}
					</Button>
				</Card.Content>
			{/if}
		</Card.Root>
	{/if}
	<Card.Root>
		<Card.Header>
			<Card.Title>Change password</Card.Title>
			<Card.Description>
				Requires your current password. The new one needs at least 8 characters, same as
				sign-in. Changing it signs out every other session on your account - this one stays
				signed in.
			</Card.Description>
		</Card.Header>
		<Card.Content class="flex max-w-sm flex-col gap-3">
			<label class="flex flex-col gap-1 text-xs">
				Current password
				<Input
					type="password"
					bind:value={currentPassword}
					disabled={busy}
					autocomplete="current-password"
				/>
			</label>
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
			<Button onclick={submit} disabled={!canSubmit}>Change password</Button>
		</Card.Content>
	</Card.Root>
</div>
</PageContainer>
