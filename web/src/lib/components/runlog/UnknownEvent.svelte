<script lang="ts">
	let { data }: { data: { type: string; raw: string } } = $props();
</script>

<span class="text-[10px] text-muted-foreground/40 font-mono">event: {data.type}</span>
