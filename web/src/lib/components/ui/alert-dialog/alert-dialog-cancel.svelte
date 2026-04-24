<script lang="ts">
	import { Button } from '$lib/components/ui/button/index.js';
	import type { Snippet } from 'svelte';
	let { onclick, children }: { onclick?: () => void; children?: Snippet } = $props();
</script>

<Button {onclick} variant="outline" size="sm">
	{@render children?.()}
</Button>
