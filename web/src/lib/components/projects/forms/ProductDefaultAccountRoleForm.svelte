<script lang="ts">
  import { SelectField } from '$lib/components/ui/select-field';

  type V = { role: 'personal' | 'brand' };
  type Props = { value: V; onChange: (v: V) => void };
  let { value, onChange }: Props = $props();
  // svelte-ignore state_referenced_locally
  let role = $state<V['role']>(value.role ?? 'personal');
  $effect(() => onChange({ role }));
</script>

<label class="flex flex-col gap-1 text-xs">
  Default account role
  <SelectField
    value={role}
    onValueChange={(v) => (role = v as V['role'])}
    options={[
      { value: 'personal', label: 'personal' },
      { value: 'brand', label: 'brand' },
    ]}
    fullWidth
  />
</label>
