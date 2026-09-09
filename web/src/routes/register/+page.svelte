<script lang="ts">
	import { goto } from '$app/navigation';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import * as Card from '$lib/components/ui/card';
	import { toast } from 'svelte-sonner';
	import Seo from '$lib/components/Seo.svelte';
	import { TONE_TEXT_CLASS } from '$lib/config/status-badges';

	type PageData = {
		authOn: boolean;
		next: string | null;
		invite: { token: string; email: string | null; orgName: string | null } | null;
		policy: 'open' | 'invite' | 'off';
		canRegister: boolean;
	};
	let { data }: { data: PageData } = $props();

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
						? 'That username is already taken'
						: body.error === 'email_taken'
							? 'That email is already registered'
							: body.error === 'invalid_or_expired_invite'
								? 'This invite is no longer valid'
								: body.error === 'rate_limited'
									? 'Too many attempts, try again shortly'
									: (body.error === 'registration_closed' || body.error === 'invite_required') &&
										  body.message
										? body.message
										: 'Could not create account';
				toast.error(message);
				return;
			}
			const okBody = (await res.json().catch(() => ({}))) as { emailVerified?: boolean };
			if (!okBody.emailVerified) {
				toast.success('Account created', {
					description: 'Check your email to verify your address before you can start a run.',
				});
			}
			await goto(data.next ?? '/', { invalidateAll: true });
		} finally {
			busy = false;
		}
	}
</script>

<Seo
	title={data.authOn ? 'Create an account' : 'Authentication disabled'}
	description="Create a Pitchbox account"
/>

<div class="min-h-screen flex items-center justify-center bg-background p-6">
	<Card.Root class="w-full max-w-sm">
		{#if !data.authOn}
			<Card.Header>
				<Card.Title>Authentication is disabled</Card.Title>
				<p class="text-xs {TONE_TEXT_CLASS.amber}">
					This instance runs with PITCHBOX_AUTH off, so there is no account to create. Set
					PITCHBOX_AUTH=on in your environment to enable registration.
				</p>
			</Card.Header>
			<Card.Content>
				<Button href="/" variant="outline" class="w-full">Go to Pitchbox</Button>
			</Card.Content>
		{:else if !data.canRegister}
			<Card.Header>
				<Card.Title>
					{data.policy === 'off' ? 'Registration is disabled' : 'This deployment is invite-only'}
				</Card.Title>
				<p class="text-xs {TONE_TEXT_CLASS.amber}">
					{data.policy === 'off'
						? 'Registration is disabled on this deployment. Ask its operator for an account.'
						: 'This deployment is invite-only. Ask an organization owner for an invite link to create an account.'}
				</p>
			</Card.Header>
			<Card.Content>
				<Button href={signInHref()} variant="outline" class="w-full">Sign in instead</Button>
			</Card.Content>
		{:else}
			<Card.Header>
				<Card.Title>Create an account</Card.Title>
				{#if data.invite}
					<p class="text-xs text-muted-foreground">
						You have been invited to join
						<span class="font-medium text-foreground">{data.invite.orgName ?? 'an organization'}</span
						>. Create an account to accept.
					</p>
				{/if}
			</Card.Header>
			<Card.Content class="flex flex-col gap-3">
				<label class="flex flex-col gap-1 text-xs">
					Username
					<Input bind:value={username} autocomplete="username" />
				</label>
				<label class="flex flex-col gap-1 text-xs">
					Email
					<Input type="email" bind:value={email} autocomplete="email" />
				</label>
				<label class="flex flex-col gap-1 text-xs">
					Password
					<Input type="password" bind:value={password} autocomplete="new-password" />
				</label>
				<Button
					onclick={submit}
					disabled={busy || !username || !email || password.length < 8}
				>
					{busy ? 'Creating…' : 'Create account'}
				</Button>
				<p class="text-center text-xs text-muted-foreground">
					Already have an account? <a href={signInHref()} class="underline">Sign in</a>
				</p>
			</Card.Content>
		{/if}
	</Card.Root>
</div>
