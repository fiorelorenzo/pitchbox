<script lang="ts">
  import { Input } from '$lib/components/ui/input';
  import TagListInput from '$lib/components/projects/TagListInput.svelte';

  type V = { valuePropositions: string[]; productUrl: string };
  type Props = { value: V; onChange: (v: V) => void; disabled?: boolean };
  let { value, onChange, disabled = false }: Props = $props();
  function patch(p: Partial<V>) {
    onChange({ ...value, ...p });
  }
</script>

<div class="space-y-3">
  <h3 class="text-sm font-medium">Value & product</h3>
  <label class="flex flex-col gap-1 text-xs">
    Value propositions
    <TagListInput
      value={value.valuePropositions}
      onChange={(v) => patch({ valuePropositions: v })}
      {disabled}
      placeholder="quick session prep"
    />
  </label>
  <label class="flex flex-col gap-1 text-xs">
    Product URL
    <Input
      value={value.productUrl}
      {disabled}
      oninput={(e) => patch({ productUrl: (e.currentTarget as HTMLInputElement).value })}
    />
  </label>
</div>
