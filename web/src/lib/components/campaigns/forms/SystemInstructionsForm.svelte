<script lang="ts">
  import { Textarea } from '$lib/components/ui/textarea';
  type Props = { value: string; onChange: (v: string) => void; disabled?: boolean };
  let { value, onChange, disabled = false }: Props = $props();
</script>

<div class="space-y-2">
  <h3 class="text-sm font-medium">System instructions</h3>
  <Textarea
    {value}
    {disabled}
    rows={6}
    oninput={(e) => onChange((e.currentTarget as HTMLTextAreaElement).value)}
    placeholder="Tone, content guidance, and what the agent should and should not do."
  />
</div>
