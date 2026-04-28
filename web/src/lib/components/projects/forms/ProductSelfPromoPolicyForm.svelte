<script lang="ts">
  type V = { default: 'never' | 'allowed' | 'on_request' };
  type Props = { value: V; onChange: (v: V) => void };
  let { value, onChange }: Props = $props();
  // svelte-ignore state_referenced_locally
  let def = $state<V['default']>(value.default ?? 'never');
  $effect(() => onChange({ default: def }));
</script>

<label class="flex flex-col gap-1 text-xs">
  Self-promo policy (default)
  <select
    class="border border-input rounded-md h-9 px-2 w-full bg-background text-sm"
    bind:value={def}
  >
    <option value="never">never</option>
    <option value="allowed">allowed</option>
    <option value="on_request">on_request</option>
  </select>
</label>
