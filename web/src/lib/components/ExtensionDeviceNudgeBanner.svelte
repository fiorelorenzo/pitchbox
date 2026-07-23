<script lang="ts">
	import { Puzzle, RefreshCw, X } from '@lucide/svelte';

	// Nudges an org toward installing or re-pairing the browser extension.
	// `kind` comes from `getExtensionDeviceNudge` (web/src/lib/server/extension-sync.ts):
	// - 'no_device' - the org never paired a device at all (discovery nudge).
	// - 'stale_device' - devices exist but none has reported in for a while
	//   (re-pair nudge).
	// Unlike ChatSyncStalledBanner (an active-error signal), this is a soft
	// suggestion, so it is dismissible: dismissing it remembers the *kind*
	// dismissed in localStorage, per org, and only that kind stays hidden - if
	// the situation changes (e.g. a stale org loses its last device) the
	// banner reappears with the new variant.
	let {
		kind = null,
		orgId = null,
	}: { kind?: 'no_device' | 'stale_device' | null; orgId?: number | null } = $props();

	const storageKey = $derived(`pitchbox.extension_nudge_dismissed.${orgId ?? 'default'}`);

	let dismissedKind = $state<string | null>(null);

	$effect(() => {
		const key = storageKey;
		try {
			dismissedKind = localStorage.getItem(key);
		} catch {
			// localStorage may be unavailable (SSR, restricted contexts).
			dismissedKind = null;
		}
	});

	const visible = $derived(!!kind && kind !== dismissedKind);

	function dismiss() {
		if (!kind) return;
		dismissedKind = kind;
		try {
			localStorage.setItem(storageKey, kind);
		} catch {
			// ignore
		}
	}

	const copy = $derived(
		kind === 'no_device'
			? {
					title: 'Get faster reply detection with the browser extension',
					body: 'No browser extension is paired with this workspace yet. Install it and pair a device from Settings > Integrations so incoming Reddit replies show up here automatically.',
				}
			: {
					title: 'Your browser extension has gone quiet',
					body: "No paired device has reported in for a while. Open Reddit in the browser it's installed in, or pair a new device from Settings > Integrations, so incoming replies keep syncing.",
				},
	);
</script>

{#if visible}
	<div
		role="alert"
		class="mb-3 flex items-start gap-2 rounded-lg border border-sky-500/40 bg-sky-500/10 px-3 py-2 text-sm text-sky-800 dark:border-sky-500/30 dark:text-sky-200"
	>
		{#if kind === 'no_device'}
			<Puzzle class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
		{:else}
			<RefreshCw class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
		{/if}
		<div class="flex-1">
			<div class="font-medium">{copy.title}</div>
			<div class="text-xs text-sky-800/85 dark:text-sky-200/80">{copy.body}</div>
		</div>
		<button
			type="button"
			onclick={dismiss}
			aria-label="Dismiss"
			class="shrink-0 rounded p-0.5 text-sky-800/70 hover:bg-sky-500/20 hover:text-sky-900 dark:text-sky-200/70 dark:hover:text-sky-100"
		>
			<X class="size-3.5" aria-hidden="true" />
		</button>
	</div>
{/if}
