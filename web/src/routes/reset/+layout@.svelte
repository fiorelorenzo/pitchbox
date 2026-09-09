<script lang="ts">
	import '../../app.css';
	import { ModeWatcher } from 'mode-watcher';
	let { children } = $props();
</script>

<!--
  Reset-password pages bypass the dashboard chrome, same as /login and
  /register (web/src/routes/login/+layout@.svelte, web/src/routes/register/
  +layout@.svelte) - one convention for every session-less auth page.
-->
<ModeWatcher defaultMode="dark" />

<div class="min-h-screen bg-background text-foreground">
	{@render children()}
</div>
