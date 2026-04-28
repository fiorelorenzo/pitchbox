<script lang="ts">
  import { Textarea } from '$lib/components/ui/textarea';

  type V = { text: string };
  type Props = { value: V; onChange: (v: V) => void };
  let { value, onChange }: Props = $props();
  // svelte-ignore state_referenced_locally
  let text = $state(value.text ?? '');
  $effect(() => onChange({ text }));
</script>

<label class="flex flex-col gap-1 text-xs">
  Pitch
  <Textarea bind:value={text} rows={3} />
</label>
