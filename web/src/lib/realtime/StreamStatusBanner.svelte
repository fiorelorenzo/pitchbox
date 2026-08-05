<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { getSseManager, connectionKeyFor, type SseStatus } from './sse';
	import { resolveBadge, resolveTone, PULSE_DOT_CLASS, TONE_BANNER_CLASS } from '$lib/config/status-badges';

	// `active` says whether this page currently has something live-dependent
	// in flight (a running campaign, an active run...). When false there is
	// nothing to stream, so the banner never renders even if the connection
	// itself is unhealthy - "idle" must never look like "broken".
	//
	// `onReconnect` fires once when the stream comes back after a real drop
	// (not the initial page-load connect), so the caller can refetch
	// whatever it renders instead of leaving it silently stale.
	let {
		active = true,
		onReconnect,
	}: {
		active?: boolean;
		onReconnect?: () => void;
	} = $props();

	let sseStatus = $state<SseStatus>('connecting');
	let justReconnected = $state(false);
	let reconnectedTimer: ReturnType<typeof setTimeout> | null = null;
	let unsub: (() => void) | null = null;

	onMount(() => {
		unsub = getSseManager().subscribeStatus((s) => {
			const prev = sseStatus;
			sseStatus = s;
			// The SSE transport does not replay missed events, so a genuine
			// reconnect (not the initial boot) means this page may be behind.
			if (s === 'live' && (prev === 'reconnecting' || prev === 'closed')) {
				onReconnect?.();
				justReconnected = true;
				if (reconnectedTimer) clearTimeout(reconnectedTimer);
				reconnectedTimer = setTimeout(() => (justReconnected = false), 5000);
			}
		});
	});

	onDestroy(() => {
		unsub?.();
		if (reconnectedTimer) clearTimeout(reconnectedTimer);
	});

	const connectionKey = $derived(connectionKeyFor(sseStatus));
	const showBanner = $derived(active && (connectionKey === 'warn' || connectionKey === 'down'));
	const bannerText = $derived(
		connectionKey === 'down'
			? 'Live updates disconnected. Refresh the page to resume.'
			: 'Live updates interrupted, reconnecting… this view may be behind.',
	);
	const bannerClass = $derived(TONE_BANNER_CLASS[resolveTone('connection-status', connectionKey)]);
	const dotClass = $derived.by(() => {
		const dot = PULSE_DOT_CLASS[resolveTone('connection-status', connectionKey)];
		return resolveBadge('connection-status', connectionKey).pulse ? `${dot} animate-pulse` : dot;
	});
</script>

{#if showBanner}
	<div class="mb-3 flex items-center gap-2 rounded-md border px-3 py-2 text-xs {bannerClass}">
		<span class="inline-block size-1.5 rounded-full shrink-0 {dotClass}"></span>
		<span>{bannerText}</span>
	</div>
{:else if justReconnected}
	<div class="mb-3 px-1 text-xs text-muted-foreground">Reconnected. View refreshed.</div>
{/if}
