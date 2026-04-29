<script lang="ts">
  import { Textarea } from '$lib/components/ui/textarea';

  type V = { default: string };
  type Props = { value: V; onChange: (v: V) => void };
  let { value, onChange }: Props = $props();
  // svelte-ignore state_referenced_locally
  let def = $state(value.default ?? '');
  $effect(() => onChange({ default: def }));
</script>

<label class="flex flex-col gap-1 text-xs">
  Disclosure (default)
  <Textarea bind:value={def} rows={2} />
</label>
