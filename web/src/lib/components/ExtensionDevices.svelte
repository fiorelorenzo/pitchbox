<script lang="ts">
	import * as Card from '$lib/components/ui/card';
	import * as Alert from '$lib/components/ui/alert';
	import { Button } from '$lib/components/ui/button';
	import { toast } from 'svelte-sonner';
	import { Copy, KeyRound, Smartphone, Trash2 } from '@lucide/svelte';
	import { onMount } from 'svelte';

	type Device = {
		id: number;
		label: string;
		createdAt: string;
		lastSeenAt: string | null;
		revokedAt: string | null;
	};

	type Props = { isAdmin: boolean };
	let { isAdmin }: Props = $props();

	let devices = $state<Device[]>([]);
	let loadingDevices = $state(true);
	let loadError = $state(false);
	let revokingId = $state<number | null>(null);

	async function loadDevices() {
		loadingDevices = true;
		loadError = false;
		try {
			const res = await fetch('/api/settings/extension-devices');
			if (!res.ok) {
				loadError = true;
				return;
			}
			const body = (await res.json()) as { devices: Device[] };
			devices = body.devices;
		} catch {
			loadError = true;
		} finally {
			loadingDevices = false;
		}
	}

	onMount(loadDevices);

	async function revoke(id: number) {
		if (revokingId) return;
		revokingId = id;
		try {
			const res = await fetch(`/api/settings/extension-devices/${id}`, { method: 'DELETE' });
			if (res.ok) {
				toast.success('Device revoked');
				await loadDevices();
			} else if (res.status === 403) {
				toast.error('You need admin access for that');
			} else {
				toast.error('Could not revoke the device');
			}
		} finally {
			revokingId = null;
		}
	}

	function relativeTime(iso: string): string {
		const diff = Math.max(0, Date.now() - new Date(iso).getTime());
		const s = Math.floor(diff / 1000);
		if (s < 60) return `${s}s ago`;
		if (s < 3600) return `${Math.floor(s / 60)}m ago`;
		if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
		return `${Math.floor(s / 86400)}d ago`;
	}

	// Pairing code generation (admin-only, POST /api/settings/extension-pairing).
	// Codes expire after 10 minutes; the countdown ticks locally from the
	// server-issued `expiresAt` so it survives clock drift on refresh but not
	// across a full reload (a fresh code is one click away either way).
	let generating = $state(false);
	let pairingCode = $state('');
	let pairingExpiresAt = $state<number | null>(null);
	let remainingMs = $state(0);

	$effect(() => {
		if (pairingExpiresAt == null) return;
		const tick = () => {
			remainingMs = Math.max(0, pairingExpiresAt! - Date.now());
		};
		tick();
		const interval = setInterval(tick, 1000);
		return () => clearInterval(interval);
	});

	const expired = $derived(pairingExpiresAt != null && remainingMs <= 0);

	function formatCountdown(ms: number): string {
		const totalSeconds = Math.ceil(ms / 1000);
		const m = Math.floor(totalSeconds / 60);
		const s = totalSeconds % 60;
		return `${m}:${String(s).padStart(2, '0')}`;
	}

	async function generateCode() {
		if (generating) return;
		generating = true;
		try {
			const res = await fetch('/api/settings/extension-pairing', { method: 'POST' });
			if (res.ok) {
				const body = (await res.json()) as { code: string; expiresAt: string };
				pairingCode = body.code;
				pairingExpiresAt = new Date(body.expiresAt).getTime();
			} else if (res.status === 403) {
				toast.error('You need admin access for that');
			} else {
				toast.error('Could not generate a pairing code');
			}
		} finally {
			generating = false;
		}
	}

	async function copyCode() {
		try {
			await navigator.clipboard.writeText(pairingCode);
			toast.success('Pairing code copied');
		} catch {
			toast.error('Could not copy, select the code and copy it manually');
		}
	}
</script>

<div class="flex flex-col gap-4">
	{#if isAdmin}
		<Card.Root size="sm">
			<Card.Header class="flex flex-row flex-nowrap items-center gap-2 space-y-0">
				<KeyRound class="size-4 shrink-0 text-muted-foreground" />
				<Card.Title class="text-base min-w-0 flex-1 truncate">Pairing code</Card.Title>
			</Card.Header>
			<Card.Content class="flex flex-col gap-3 text-sm">
				<p class="text-xs text-muted-foreground">
					Generate a one-time code to pair a device that is not signed into this dashboard. Enter
					it in the extension's <em>Add connection</em> form. Codes expire after 10 minutes.
				</p>

				{#if pairingCode && !expired}
					<div class="flex items-center gap-2 rounded-md border border-border/60 px-3 py-2">
						<span class="flex-1 font-mono text-lg tracking-wide">{pairingCode}</span>
						<span class="text-xs tabular-nums text-muted-foreground">
							{formatCountdown(remainingMs)}
						</span>
						<Button variant="ghost" size="sm" onclick={copyCode} aria-label="Copy pairing code">
							<Copy class="size-3.5" />
						</Button>
					</div>
				{:else if pairingCode && expired}
					<Alert.Root variant="destructive">
						<Alert.Title>Code expired</Alert.Title>
						<Alert.Description>Generate a new one below.</Alert.Description>
					</Alert.Root>
				{/if}

				<div>
					<Button size="sm" onclick={generateCode} loading={generating}>
						Generate pairing code
					</Button>
				</div>
			</Card.Content>
		</Card.Root>
	{/if}

	<Card.Root size="sm">
		<Card.Header class="flex flex-row flex-nowrap items-center gap-2 space-y-0">
			<Smartphone class="size-4 shrink-0 text-muted-foreground" />
			<Card.Title class="text-base min-w-0 flex-1 truncate">Paired devices</Card.Title>
		</Card.Header>
		<Card.Content class="flex flex-col gap-2 text-sm">
			{#if loadingDevices}
				<p class="text-xs text-muted-foreground">Loading devices...</p>
			{:else if loadError}
				<Alert.Root variant="destructive">
					<Alert.Title>Could not load devices</Alert.Title>
					<Alert.Description>
						<Button variant="ghost" size="sm" onclick={loadDevices}>Retry</Button>
					</Alert.Description>
				</Alert.Root>
			{:else if devices.length === 0}
				<Alert.Root>
					<Alert.Title>No devices yet</Alert.Title>
					<Alert.Description>
						Pair the extension from a signed-in tab, or with a pairing code above.
					</Alert.Description>
				</Alert.Root>
			{:else}
				<div class="flex flex-col divide-y divide-border">
					{#each devices as d (d.id)}
						<div class="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0">
							<span class="flex-1 truncate text-sm font-medium">{d.label}</span>
							{#if d.revokedAt}
								<span
									class="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground"
								>
									Revoked
								</span>
							{:else}
								<span class="text-xs text-muted-foreground">
									{d.lastSeenAt ? `seen ${relativeTime(d.lastSeenAt)}` : 'never seen'}
								</span>
							{/if}
							{#if isAdmin && !d.revokedAt}
								<Button
									variant="ghost"
									size="sm"
									class="text-destructive hover:text-destructive"
									onclick={() => revoke(d.id)}
									loading={revokingId === d.id}
								>
									<Trash2 class="size-3.5" />
									Revoke
								</Button>
							{/if}
						</div>
					{/each}
				</div>
			{/if}
		</Card.Content>
	</Card.Root>
</div>
