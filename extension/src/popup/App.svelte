<script lang="ts">
	import { onMount } from 'svelte';
	import { getSettings, setSettings } from '../lib/storage.js';
	import { api } from '../lib/api.js';

	type Status = { kind: 'idle' | 'ok' | 'err'; msg?: string };

	let backendUrl = $state('');
	let pairingCode = $state('');
	let token = $state('');
	let lastHandshakeAt = $state<string | null>(null);
	let lastDmSyncAt = $state<string | null>(null);
	let status = $state<Status>({ kind: 'idle' });
	let busy = $state(false);
	let syncing = $state(false);
	let mode = $state<'pair' | 'manual'>('pair');

	onMount(async () => {
		const s = await getSettings();
		backendUrl = s.backendUrl ?? '';
		token = s.token ?? '';
		lastHandshakeAt = s.lastHandshakeAt ?? null;
		lastDmSyncAt = s.lastDmSyncAt ?? null;
		if (token) status = { kind: 'ok', msg: 'Connected' };
	});

	function fmtAgo(iso: string | null): string {
		if (!iso) return 'never';
		const ms = Date.now() - new Date(iso).getTime();
		if (ms < 60_000) return `${Math.floor(ms / 1000)}s ago`;
		if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
		if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
		return `${Math.floor(ms / 86_400_000)}d ago`;
	}

	async function pair() {
		const url = backendUrl.trim().replace(/\/$/, '');
		const code = pairingCode.trim();
		if (!url || !code) {
			status = { kind: 'err', msg: 'Backend URL and pairing code required.' };
			return;
		}
		busy = true;
		try {
			const res = await fetch(`${url}/api/extension/pair`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ code }),
			});
			if (!res.ok) {
				const text = await res.text();
				status = { kind: 'err', msg: `Pairing failed (${res.status}): ${text || 'no body'}` };
				return;
			}
			const body = (await res.json()) as { token: string };
			await setSettings({ backendUrl: url, token: body.token });
			token = body.token;
			const r = await api.handshake();
			if (r.ok) {
				await setSettings({ lastHandshakeAt: new Date().toISOString() });
				lastHandshakeAt = new Date().toISOString();
				status = { kind: 'ok', msg: `Paired — dashboard v${r.data.version}.` };
				pairingCode = '';
			} else {
				status = { kind: 'err', msg: `Token saved but handshake failed: ${r.error || r.status}` };
			}
		} finally {
			busy = false;
		}
	}

	async function manualConnect() {
		const url = backendUrl.trim().replace(/\/$/, '');
		const t = token.trim();
		if (!url || !t) {
			status = { kind: 'err', msg: 'Backend URL and token required.' };
			return;
		}
		busy = true;
		try {
			await setSettings({ backendUrl: url, token: t });
			const r = await api.handshake();
			if (r.ok) {
				await setSettings({ lastHandshakeAt: new Date().toISOString() });
				lastHandshakeAt = new Date().toISOString();
				status = { kind: 'ok', msg: `Connected — dashboard v${r.data.version}.` };
			} else {
				status = { kind: 'err', msg: `Failed (${r.status}): ${r.error || 'no response'}` };
			}
		} finally {
			busy = false;
		}
	}

	async function disconnect() {
		await setSettings({ token: undefined, lastHandshakeAt: undefined });
		token = '';
		lastHandshakeAt = null;
		status = { kind: 'idle' };
	}

	async function syncNow() {
		syncing = true;
		try {
			const reply = await new Promise<{
				ok: boolean;
				inserted?: number;
				replied?: number;
				reason?: string;
			}>((resolve) => chrome.runtime.sendMessage({ type: 'pitchbox:dm-sync:run' }, resolve));
			if (!reply.ok) {
				status = { kind: 'err', msg: `Sync failed: ${reply.reason ?? 'unknown'}` };
			} else {
				status = {
					kind: 'ok',
					msg: `Sync OK — ${reply.inserted ?? 0} new, ${reply.replied ?? 0} replied.`,
				};
			}
			const s = await getSettings();
			lastDmSyncAt = s.lastDmSyncAt ?? null;
		} finally {
			syncing = false;
		}
	}
</script>

<main class="flex flex-col gap-3 p-4">
	<header class="flex items-center gap-2 pb-2 border-b border-[var(--color-border)]">
		<svg viewBox="0 0 512 512" class="size-7 shrink-0" aria-hidden="true">
			<rect x="16" y="16" width="480" height="480" rx="112" fill="#0b1220" />
			<path
				d="M124 332 L124 200 L256 132 L388 200 L388 332 Z"
				fill="none"
				stroke="#38bdf8"
				stroke-width="28"
				stroke-linejoin="round"
			/>
			<path
				d="M256 132 L256 240"
				stroke="#38bdf8"
				stroke-width="28"
				stroke-linecap="round"
			/>
			<path
				d="M178 280 L256 202 L334 280"
				fill="none"
				stroke="#f8fafc"
				stroke-width="36"
				stroke-linecap="round"
				stroke-linejoin="round"
			/>
		</svg>
		<h1 class="text-sm font-semibold flex-1">Pitchbox</h1>
		{#if token}
			<button
				class="text-[10px] text-[var(--color-muted)] hover:text-[var(--color-fg)] underline-offset-2 hover:underline"
				onclick={disconnect}
			>
				Disconnect
			</button>
		{/if}
	</header>

	{#if !token}
		<div class="flex gap-1 text-[11px]">
			<button
				class="flex-1 rounded-md py-1.5 px-2 transition-colors {mode === 'pair'
					? 'bg-[var(--color-border)] text-[var(--color-fg)]'
					: 'text-[var(--color-muted)] hover:text-[var(--color-fg)]'}"
				onclick={() => (mode = 'pair')}
			>
				Pair with code
			</button>
			<button
				class="flex-1 rounded-md py-1.5 px-2 transition-colors {mode === 'manual'
					? 'bg-[var(--color-border)] text-[var(--color-fg)]'
					: 'text-[var(--color-muted)] hover:text-[var(--color-fg)]'}"
				onclick={() => (mode = 'manual')}
			>
				Token (legacy)
			</button>
		</div>

		<label class="flex flex-col gap-1 text-[11px] text-[var(--color-muted)]">
			Backend URL
			<input
				type="url"
				bind:value={backendUrl}
				placeholder="http://127.0.0.1:5180"
				class="rounded-md border border-[var(--color-border)] bg-[var(--color-bg-elev)] px-2 py-1.5 text-[13px] text-[var(--color-fg)] outline-none focus:border-[var(--color-accent)]"
			/>
		</label>

		{#if mode === 'pair'}
			<label class="flex flex-col gap-1 text-[11px] text-[var(--color-muted)]">
				Pairing code
				<input
					type="text"
					bind:value={pairingCode}
					placeholder="from Dashboard → Settings → Integrations"
					autocomplete="off"
					class="rounded-md border border-[var(--color-border)] bg-[var(--color-bg-elev)] px-2 py-1.5 text-[13px] text-[var(--color-fg)] outline-none focus:border-[var(--color-accent)]"
				/>
			</label>
			<button
				disabled={busy}
				onclick={pair}
				class="rounded-md bg-[var(--color-accent)] text-[var(--color-bg)] font-medium py-1.5 disabled:opacity-60 hover:brightness-110"
			>
				{busy ? 'Pairing…' : 'Pair'}
			</button>
		{:else}
			<label class="flex flex-col gap-1 text-[11px] text-[var(--color-muted)]">
				API token
				<input
					type="password"
					bind:value={token}
					placeholder="64-character hex"
					autocomplete="off"
					class="rounded-md border border-[var(--color-border)] bg-[var(--color-bg-elev)] px-2 py-1.5 text-[13px] text-[var(--color-fg)] outline-none focus:border-[var(--color-accent)]"
				/>
			</label>
			<button
				disabled={busy}
				onclick={manualConnect}
				class="rounded-md bg-[var(--color-accent)] text-[var(--color-bg)] font-medium py-1.5 disabled:opacity-60 hover:brightness-110"
			>
				{busy ? 'Connecting…' : 'Connect'}
			</button>
		{/if}
	{:else}
		<div class="rounded-md bg-[var(--color-bg-elev)] px-3 py-2 text-[11px] text-[var(--color-muted)]">
			<div class="text-[var(--color-fg)] font-medium">{backendUrl}</div>
			<div>Last handshake: {fmtAgo(lastHandshakeAt)}</div>
			<div>DM sync: {fmtAgo(lastDmSyncAt)}</div>
		</div>
		<button
			disabled={syncing}
			onclick={syncNow}
			class="rounded-md border border-[var(--color-border)] py-1.5 text-[12px] text-[var(--color-fg)] hover:bg-[var(--color-bg-elev)] disabled:opacity-60"
		>
			{syncing ? 'Syncing…' : 'Sync now'}
		</button>
	{/if}

	{#if status.kind !== 'idle' && status.msg}
		<div
			class="rounded-md px-3 py-2 text-[11px] {status.kind === 'ok'
				? 'bg-emerald-500/15 text-emerald-300'
				: 'bg-rose-500/15 text-rose-300'}"
		>
			{status.msg}
		</div>
	{/if}
</main>
