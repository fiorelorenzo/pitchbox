<svelte:options runes={false} />

<script lang="ts">
	import { Loader2 } from 'lucide-svelte';
	export let loading = false;
	export let variant: 'primary' | 'ghost' | 'danger' = 'primary';
	export let disabled = false;
</script>

<button
	class="px-3 py-1.5 rounded text-sm inline-flex items-center gap-2 transition disabled:opacity-50"
	class:bg-indigo-600={variant === 'primary'}
	class:hover:bg-indigo-500={variant === 'primary'}
	class:bg-red-600={variant === 'danger'}
	class:hover:bg-red-500={variant === 'danger'}
	class:hover:bg-slate-800={variant === 'ghost'}
	disabled={disabled || loading}
	on:click
>
	{#if loading}<Loader2 class="w-4 h-4 animate-spin" />{/if}
	<slot />
</button>
