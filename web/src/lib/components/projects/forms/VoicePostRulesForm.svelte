<script lang="ts">
  import { Input } from '$lib/components/ui/input';
  import TagListInput from '../TagListInput.svelte';

  type V = { hardBans: string[]; dos: string[]; lengthRange: [number, number] };
  type Props = { value: V; onChange: (v: V) => void };
  let { value, onChange }: Props = $props();
  // svelte-ignore state_referenced_locally
  let hardBans = $state<string[]>(value.hardBans ?? []);
  // svelte-ignore state_referenced_locally
  let dos = $state<string[]>(value.dos ?? []);
  // svelte-ignore state_referenced_locally
  let min = $state<number>(value.lengthRange?.[0] ?? 60);
  // svelte-ignore state_referenced_locally
  let max = $state<number>(value.lengthRange?.[1] ?? 150);
  $effect(() => onChange({ hardBans, dos, lengthRange: [min, max] }));
</script>

<div class="space-y-3">
  <label class="flex flex-col gap-1 text-xs">Hard bans<TagListInput bind:value={hardBans} /></label>
  <label class="flex flex-col gap-1 text-xs">Do's<TagListInput bind:value={dos} /></label>
  <div class="flex gap-3">
    <label class="flex flex-col gap-1 text-xs flex-1">Min length (words)<Input type="number" bind:value={min} /></label>
    <label class="flex flex-col gap-1 text-xs flex-1">Max length (words)<Input type="number" bind:value={max} /></label>
  </div>
</div>
