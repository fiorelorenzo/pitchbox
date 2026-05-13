<script lang="ts">
	import { Dialog as DialogPrimitive } from 'bits-ui';
	let { open = $bindable(false), children, onOpenChange }: { open?: boolean; children?: import('svelte').Snippet; onOpenChange?: (v: boolean) => void } = $props();
</script>

<DialogPrimitive.Root bind:open {onOpenChange}>
	{@render children?.()}
</DialogPrimitive.Root>
