<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import * as Card from '$lib/components/ui/card';
	import { toast } from 'svelte-sonner';
	import Seo from '$lib/components/Seo.svelte';
	import { TONE_TEXT_CLASS } from '$lib/config/status-badges';

	let { data }: { data: { authOn: boolean; firstUser: boolean } } = $props();

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
				toast.error(data.firstUser ? 'Could not create user' : 'Invalid credentials');
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
	title={data.authOn ? 'Sign in' : 'Authentication disabled'}
	description="Sign in to Pitchbox"
/>

<div class="min-h-screen flex items-center justify-center bg-background p-6">
	<Card.Root class="w-full max-w-sm">
		{#if !data.authOn}
			<Card.Header>
				<Card.Title>Authentication is disabled</Card.Title>
				<p class="text-xs {TONE_TEXT_CLASS.amber}">
					This instance runs with PITCHBOX_AUTH off, so there is no account to sign in to. Set
					PITCHBOX_AUTH=on in your environment to enable sign-in.
				</p>
			</Card.Header>
			<Card.Content>
				<Button href="/" variant="outline" class="w-full">Go to Pitchbox</Button>
			</Card.Content>
		{:else}
			<Card.Header>
				<Card.Title>{data.firstUser ? 'Create the first user' : 'Sign in to Pitchbox'}</Card.Title>
				{#if data.firstUser}
					<p class="text-xs text-muted-foreground">
						No user exists yet. The credentials you enter below will create the admin account.
					</p>
				{/if}
			</Card.Header>
			<Card.Content class="flex flex-col gap-3">
				<label class="flex flex-col gap-1 text-xs">
					Username
					<Input bind:value={username} autocomplete="username" />
				</label>
				<label class="flex flex-col gap-1 text-xs">
					Password
					<Input type="password" bind:value={password} autocomplete="current-password" />
				</label>
				<Button onclick={submit} disabled={busy || !username || password.length < 8}>
					{data.firstUser ? 'Create' : 'Sign in'}
				</Button>
			</Card.Content>
		{/if}
	</Card.Root>
</div>
