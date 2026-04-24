<script lang="ts">
	import '../app.css';

	let { children } = $props();
</script>

<div class="min-h-screen bg-slate-950 text-slate-100">
	{@render children()}
</div>
