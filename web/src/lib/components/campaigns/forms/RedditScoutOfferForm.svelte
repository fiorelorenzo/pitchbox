<script lang="ts">
  import { Input } from '$lib/components/ui/input';
  import { Textarea } from '$lib/components/ui/textarea';

  type V = { productUrl: string; subject: string; text: string };
  type Props = { value: V; onChange: (v: V) => void; disabled?: boolean };
  let { value, onChange, disabled = false }: Props = $props();
  function patch(p: Partial<V>) {
    onChange({ ...value, ...p });
  }
</script>

<div class="space-y-3">
  <h3 class="text-sm font-medium">Offer</h3>
  <label class="flex flex-col gap-1 text-xs">
    Product URL
    <Input
      value={value.productUrl}
      {disabled}
      oninput={(e) => patch({ productUrl: (e.currentTarget as HTMLInputElement).value })}
    />
  </label>
  <label class="flex flex-col gap-1 text-xs">
    DM subject
    <Input
      value={value.subject}
      {disabled}
      oninput={(e) => patch({ subject: (e.currentTarget as HTMLInputElement).value })}
    />
  </label>
  <label class="flex flex-col gap-1 text-xs">
    DM body
    <Textarea
      value={value.text}
      {disabled}
      rows={4}
      oninput={(e) => patch({ text: (e.currentTarget as HTMLTextAreaElement).value })}
    />
  </label>
</div>
