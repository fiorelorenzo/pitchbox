<script lang="ts">
	import '../../app.css';
	import { ModeWatcher } from 'mode-watcher';
	let { children } = $props();
</script>

<!--
  Register page bypasses the dashboard chrome, same as /login
  (web/src/routes/login/+layout@.svelte) - one convention for both.
-->
<ModeWatcher defaultMode="dark" />

<div class="min-h-screen bg-background text-foreground">
	{@render children()}
</div>
