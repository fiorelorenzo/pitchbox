<script lang="ts">
  import '../../app.css';
  import { ModeWatcher } from 'mode-watcher';
  let { children } = $props();
</script>

<!--
  Login page bypasses the dashboard chrome but still needs the theme watcher
  so the user's chosen mode (system/light/dark) is honored here too.
-->
<ModeWatcher defaultMode="dark" />

<div class="min-h-screen bg-background text-foreground">
  {@render children()}
</div>
