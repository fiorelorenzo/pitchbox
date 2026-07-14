<script lang="ts">
	import * as Card from '$lib/components/ui/card';
	import * as Alert from '$lib/components/ui/alert';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import Seo from '$lib/components/Seo.svelte';
	import { toast } from 'svelte-sonner';
	import { invalidateAll } from '$app/navigation';
	import { ShieldAlert } from '@lucide/svelte';

	type Failure = { id: number; identifier: string; failedAt: string; kind: string };
	type Policy = { maxAttempts: number; windowMinutes: number; lockoutMinutes: number };
	type PageData = { policy: Policy; failures: Failure[]; isAdmin?: boolean };

	let { data }: { data: PageData } = $props();
	const isAdmin = $derived(data.isAdmin ?? true);
	let unlockTarget = $state('');
	let busy = $state(false);

	function relative(iso: string): string {
		const ts = new Date(iso).getTime();
		const diff = Math.max(0, Date.now() - ts);
		const s = Math.floor(diff / 1000);
		if (s < 60) return `${s}s ago`;
		if (s < 3600) return `${Math.floor(s / 60)}m ago`;
		if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
		return `${Math.floor(s / 86400)}d ago`;
	}

	async function unlock() {
		const name = unlockTarget.trim();
		if (!name) {
			toast.error('Enter a username first');
			return;
		}
		busy = true;
		try {
			const res = await fetch('/api/auth/unlock', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ username: name }),
			});
			if (res.ok) {
				const body = (await res.json()) as { cleared: number };
				toast.success(`Cleared ${body.cleared} failure(s) for ${name}`);
				unlockTarget = '';
				await invalidateAll();
			} else if (res.status === 403) {
				toast.error('You need admin access for that');
			} else {
				toast.error('Unlock failed', { description: await res.text() });
			}
		} finally {
			busy = false;
		}
	}
</script>

<Seo title="Settings - Security" description="Recent failed logins and account lockout controls." />

<PageHeader
	title="Security"
	description="Recent failed logins and account lockout controls."
/>

<div class="mt-4 grid gap-4">
	<Card.Root>
		<Card.Header>
			<Card.Title>Policy</Card.Title>
			<Card.Description>
				Lockout fires after {data.policy.maxAttempts} failed attempts within {data.policy.windowMinutes}
				minute(s); attempts then return HTTP 429 for {data.policy.lockoutMinutes} minute(s).
				Tune via the <code>auth_policy</code> row in <code>app_config</code>.
			</Card.Description>
		</Card.Header>
	</Card.Root>

	{#if isAdmin}
		<Card.Root>
			<Card.Header>
				<Card.Title>Unlock account</Card.Title>
				<Card.Description>Clears the rolling failure counter for the given username.</Card.Description>
			</Card.Header>
			<Card.Content>
				<div class="flex flex-col gap-2 sm:flex-row sm:items-center">
					<Input
						type="text"
						placeholder="username"
						bind:value={unlockTarget}
						disabled={busy}
						class="sm:max-w-xs"
					/>
					<Button onclick={unlock} disabled={busy || unlockTarget.trim().length === 0}>
						Unlock account
					</Button>
				</div>
			</Card.Content>
		</Card.Root>
	{/if}

	<Card.Root>
		<Card.Header>
			<Card.Title>Recent failures</Card.Title>
			<Card.Description>Last 50 failed login attempts (most recent first).</Card.Description>
		</Card.Header>
		<Card.Content>
			{#if data.failures.length === 0}
				<Alert.Root>
					<ShieldAlert class="h-4 w-4" />
					<Alert.Title>All quiet</Alert.Title>
					<Alert.Description>No failed login attempts on record.</Alert.Description>
				</Alert.Root>
			{:else}
				<div class="overflow-x-auto rounded-md border">
					<table class="min-w-full text-sm">
						<thead class="bg-muted/40 text-left text-xs uppercase tracking-wide">
							<tr>
								<th class="px-3 py-2 font-medium">Identifier</th>
								<th class="px-3 py-2 font-medium">Kind</th>
								<th class="px-3 py-2 font-medium">When</th>
							</tr>
						</thead>
						<tbody>
							{#each data.failures as f (f.id)}
								<tr class="border-t">
									<td class="px-3 py-2 font-mono text-xs">{f.identifier}</td>
									<td class="px-3 py-2">{f.kind}</td>
									<td class="px-3 py-2 text-muted-foreground">{relative(f.failedAt)}</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{/if}
		</Card.Content>
	</Card.Root>
</div>
