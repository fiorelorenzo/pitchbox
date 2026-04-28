<script lang="ts">
  import { SelectField } from '$lib/components/ui/select-field';

  type V = { default: 'never' | 'allowed' | 'on_request' };
  type Props = { value: V; onChange: (v: V) => void };
  let { value, onChange }: Props = $props();
  // svelte-ignore state_referenced_locally
  let def = $state<V['default']>(value.default ?? 'never');
  $effect(() => onChange({ default: def }));
</script>

<label class="flex flex-col gap-1 text-xs">
  Self-promo policy (default)
  <SelectField
    value={def}
    onValueChange={(v) => (def = v as V['default'])}
    options={[
      { value: 'never', label: 'never' },
      { value: 'allowed', label: 'allowed' },
      { value: 'on_request', label: 'on_request' },
    ]}
    fullWidth
  />
</label>
