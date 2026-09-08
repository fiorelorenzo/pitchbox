<!--
  Stand-in for $ui/button in tests that mount a real component tree.

  The real button.svelte (extension/src/lib/components/ui/button) pulls in
  @lucide/svelte's loader-circle icon for its `loading` state. That package
  ships one raw .svelte file per icon under node_modules, and neither the
  root nor the extension's own vitest config transforms .svelte files inside
  node_modules (only workspace source goes through the svelte plugin), so
  mounting the real Button under either fails with "Unknown file extension
  .svelte" before a single test runs. This keeps the only two things
  ActivityRow.svelte's tests actually need from Button - a clickable,
  disable-able element wrapping its label - without touching that package.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';

  let {
    disabled = false,
    onclick,
    children,
  }: { disabled?: boolean; onclick?: () => void; children?: Snippet } = $props();
</script>

<button {disabled} onclick={onclick}>
  {@render children?.()}
</button>
