<script lang="ts">
	import type { HTMLTableAttributes } from "svelte/elements";
	import { cn, type WithElementRef } from "$lib/utils.js";

	let {
		ref = $bindable(null),
		class: className,
		children,
		...restProps
	}: WithElementRef<HTMLTableAttributes> = $props();

	// Fade-edge scroll affordance (#244): any table that overflows
	// horizontally signals there is more content off to the side, instead of
	// clipping columns with no indication. Every current caller renders this
	// inside a Card, hence `from-card`.
	let containerEl = $state<HTMLDivElement | null>(null);
	let canScrollLeft = $state(false);
	let canScrollRight = $state(false);

	function updateEdges() {
		const el = containerEl;
		if (!el) return;
		canScrollLeft = el.scrollLeft > 0;
		canScrollRight = Math.ceil(el.scrollLeft + el.clientWidth) < el.scrollWidth;
	}

	$effect(() => {
		const el = containerEl;
		if (!el) return;
		updateEdges();
		const resizeObserver = new ResizeObserver(updateEdges);
		resizeObserver.observe(el);
		if (el.firstElementChild) resizeObserver.observe(el.firstElementChild);
		el.addEventListener("scroll", updateEdges, { passive: true });
		return () => {
			resizeObserver.disconnect();
			el.removeEventListener("scroll", updateEdges);
		};
	});
</script>

<!--
	The overlays are siblings of the scroller, not children of it: an absolutely
	positioned element inside an overflow container is laid out against its
	padding box but still scrolls with the content, so a fade placed inside would
	drift away from the edge as soon as the user scrolled. Wrapping instead keeps
	both edges pinned to the visible box.
-->
<div data-slot="table-container" class="relative w-full">
	<div bind:this={containerEl} class="w-full overflow-x-auto">
		<table bind:this={ref} data-slot="table" class={cn("w-full caption-bottom text-sm", className)} {...restProps}>
			{@render children?.()}
		</table>
	</div>
	<div
		aria-hidden="true"
		class={cn(
			"pointer-events-none absolute inset-y-0 left-0 w-6 bg-linear-to-r from-card to-transparent transition-opacity duration-150",
			canScrollLeft ? "opacity-100" : "opacity-0",
		)}
	></div>
	<div
		aria-hidden="true"
		class={cn(
			"pointer-events-none absolute inset-y-0 right-0 w-6 bg-linear-to-l from-card to-transparent transition-opacity duration-150",
			canScrollRight ? "opacity-100" : "opacity-0",
		)}
	></div>
</div>
