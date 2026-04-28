<script lang="ts">
  type V = { role: 'personal' | 'brand' };
  type Props = { value: V; onChange: (v: V) => void };
  let { value, onChange }: Props = $props();
  // svelte-ignore state_referenced_locally
  let role = $state<V['role']>(value.role ?? 'personal');
  $effect(() => onChange({ role }));
</script>

<label class="flex flex-col gap-1 text-xs">
  Default account role
  <select
    class="border border-input rounded-md h-9 px-2 w-full bg-background text-sm"
    bind:value={role}
  >
    <option value="personal">personal</option>
    <option value="brand">brand</option>
  </select>
</label>
