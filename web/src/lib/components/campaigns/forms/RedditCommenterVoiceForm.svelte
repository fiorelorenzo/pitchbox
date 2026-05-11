<script lang="ts">
  import { Input } from '$lib/components/ui/input';
  import { SelectField } from '$lib/components/ui/select-field';
  import TagListInput from '$lib/components/projects/TagListInput.svelte';

  type V = {
    tone: 'casual' | 'neutral' | 'professional';
    hardBans: string[];
    dos: string[];
    disclosure: string;
  };
  type Props = { value: V; onChange: (v: V) => void; disabled?: boolean };
  let { value, onChange, disabled = false }: Props = $props();
  function patch(p: Partial<V>) {
    onChange({ ...value, ...p });
  }
</script>

<div class="space-y-3">
  <h3 class="text-sm font-medium">Voice</h3>
  <label class="flex flex-col gap-1 text-xs">
    Tone
    <SelectField
      value={value.tone}
      onValueChange={(v) => patch({ tone: v as V['tone'] })}
      options={[
        { value: 'casual', label: 'casual' },
        { value: 'neutral', label: 'neutral' },
        { value: 'professional', label: 'professional' },
      ]}
      {disabled}
      fullWidth
    />
  </label>
  <label class="flex flex-col gap-1 text-xs">
    Hard bans
    <TagListInput
      value={value.hardBans}
      onChange={(v) => patch({ hardBans: v })}
      {disabled}
    />
  </label>
  <label class="flex flex-col gap-1 text-xs">
    Do's
    <TagListInput
      value={value.dos}
      onChange={(v) => patch({ dos: v })}
      {disabled}
    />
  </label>
  <label class="flex flex-col gap-1 text-xs">
    Disclosure
    <Input
      value={value.disclosure}
      {disabled}
      oninput={(e) => patch({ disclosure: (e.currentTarget as HTMLInputElement).value })}
    />
  </label>
</div>
