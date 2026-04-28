<script lang="ts">
  import { Input } from '$lib/components/ui/input';

  type V = { url: string };
  type Props = { value: V; onChange: (v: V) => void };
  let { value, onChange }: Props = $props();
  // svelte-ignore state_referenced_locally
  let url = $state(value.url ?? '');
  $effect(() => onChange({ url }));
</script>

<label class="flex flex-col gap-1 text-xs">
  URL
  <Input type="url" bind:value={url} placeholder="https://example.com" />
</label>
