<script lang="ts">
	import { Button } from '$lib/components/ui/button/index.js';
	import type { Snippet } from 'svelte';
	let { onclick, children, disabled, variant = 'destructive' }: { onclick?: () => void; children?: Snippet; disabled?: boolean; variant?: 'default' | 'destructive' | 'outline' | 'secondary' | 'ghost' | 'link' } = $props();
</script>

<Button {onclick} {disabled} {variant} size="sm">
	{@render children?.()}
</Button>
