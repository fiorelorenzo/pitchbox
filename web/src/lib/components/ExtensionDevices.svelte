<script lang="ts">
	import * as Card from '$lib/components/ui/card';
	import * as Alert from '$lib/components/ui/alert';
	import { Button } from '$lib/components/ui/button';
	import { toast } from 'svelte-sonner';
	import { Copy, KeyRound, Smartphone, Trash2 } from '@lucide/svelte';
	import { onMount } from 'svelte';
	import { page } from '$app/stores';
	import { t, type Locale } from '$lib/i18n/index.js';

	const locale = $derived($page.data.locale as Locale);

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
				toast.success(t(locale, 'settings.extension.devices.device-revoked'));
				await loadDevices();
			} else if (res.status === 403) {
				toast.error(t(locale, 'settings.extension.devices.error-admin-required'));
			} else {
				toast.error(t(locale, 'settings.extension.devices.error-revoke-failed'));
			}
		} finally {
			revokingId = null;
		}
	}

	function relativeTime(iso: string): string {
		const diff = Math.max(0, Date.now() - new Date(iso).getTime());
		const s = Math.floor(diff / 1000);
		if (s < 60) return t(locale, 'settings.extension.devices.age-seconds', { n: s });
		if (s < 3600)
			return t(locale, 'settings.extension.devices.age-minutes', { n: Math.floor(s / 60) });
		if (s < 86400)
			return t(locale, 'settings.extension.devices.age-hours', { n: Math.floor(s / 3600) });
		return t(locale, 'settings.extension.devices.age-days', { n: Math.floor(s / 86400) });
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
				toast.error(t(locale, 'settings.extension.devices.error-admin-required'));
			} else {
				toast.error(t(locale, 'settings.extension.devices.error-generate-failed'));
			}
		} finally {
			generating = false;
		}
	}

	async function copyCode() {
		try {
			await navigator.clipboard.writeText(pairingCode);
			toast.success(t(locale, 'settings.extension.devices.pairing-copied'));
		} catch {
			toast.error(t(locale, 'settings.extension.devices.copy-failed'));
		}
	}
</script>

<div class="flex flex-col gap-4">
	{#if isAdmin}
		<Card.Root size="sm">
			<Card.Header class="flex flex-row flex-nowrap items-center gap-2 space-y-0">
				<KeyRound class="size-4 shrink-0 text-muted-foreground" />
				<Card.Title class="text-base min-w-0 flex-1 truncate"
					>{t(locale, 'settings.extension.devices.pairing-title')}</Card.Title
				>
			</Card.Header>
			<Card.Content class="flex flex-col gap-3 text-sm">
				<p class="text-xs text-muted-foreground">
					{t(locale, 'settings.extension.devices.pairing-description-lead')}
					<em>Add connection</em>
					{t(locale, 'settings.extension.devices.pairing-description-tail')}
				</p>

				{#if pairingCode && !expired}
					<div class="flex items-center gap-2 rounded-md border border-border/60 px-3 py-2">
						<span class="flex-1 font-mono text-lg tracking-wide">{pairingCode}</span>
						<span class="text-xs tabular-nums text-muted-foreground">
							{formatCountdown(remainingMs)}
						</span>
						<Button
							variant="ghost"
							size="sm"
							onclick={copyCode}
							aria-label={t(locale, 'settings.extension.devices.copy-aria-label')}
						>
							<Copy class="size-3.5" />
						</Button>
					</div>
				{:else if pairingCode && expired}
					<Alert.Root variant="destructive">
						<Alert.Title>{t(locale, 'settings.extension.devices.code-expired-title')}</Alert.Title>
						<Alert.Description
							>{t(locale, 'settings.extension.devices.code-expired-description')}</Alert.Description
						>
					</Alert.Root>
				{/if}

				<div>
					<Button size="sm" onclick={generateCode} loading={generating}>
						{t(locale, 'settings.extension.devices.generate-code')}
					</Button>
				</div>
			</Card.Content>
		</Card.Root>
	{/if}

	<Card.Root size="sm">
		<Card.Header class="flex flex-row flex-nowrap items-center gap-2 space-y-0">
			<Smartphone class="size-4 shrink-0 text-muted-foreground" />
				<Card.Title class="text-base min-w-0 flex-1 truncate"
					>{t(locale, 'settings.extension.devices.paired-devices-title')}</Card.Title
				>
		</Card.Header>
		<Card.Content class="flex flex-col gap-2 text-sm">
			{#if loadingDevices}
				<p class="text-xs text-muted-foreground">{t(locale, 'settings.extension.devices.loading')}</p>
			{:else if loadError}
				<Alert.Root variant="destructive">
					<Alert.Title>{t(locale, 'settings.extension.devices.load-error-title')}</Alert.Title>
					<Alert.Description>
						<Button variant="ghost" size="sm" onclick={loadDevices}
							>{t(locale, 'settings.extension.devices.retry')}</Button
						>
					</Alert.Description>
				</Alert.Root>
			{:else if devices.length === 0}
				<Alert.Root>
					<Alert.Title>{t(locale, 'settings.extension.devices.empty-title')}</Alert.Title>
					<Alert.Description>
						{t(locale, 'settings.extension.devices.empty-description')}
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
									{t(locale, 'settings.extension.devices.revoked-badge')}
								</span>
							{:else}
								<span class="text-xs text-muted-foreground" title={d.lastSeenAt ?? undefined}>
								{d.lastSeenAt
									? t(locale, 'settings.extension.devices.seen-ago', {
											time: relativeTime(d.lastSeenAt),
										})
									: t(locale, 'settings.extension.devices.never-seen')}
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
									{t(locale, 'settings.extension.devices.revoke')}
								</Button>
							{/if}
						</div>
					{/each}
				</div>
			{/if}
		</Card.Content>
	</Card.Root>
</div>
