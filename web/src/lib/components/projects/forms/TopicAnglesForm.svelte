<script lang="ts">
  import TagListInput from '../TagListInput.svelte';

  type V = string[];
  type Props = { value: V; onChange: (v: V) => void };
  let { value, onChange }: Props = $props();
  // svelte-ignore state_referenced_locally
  let tags = $state<string[]>(Array.isArray(value) ? value : []);
  $effect(() => onChange(tags));
</script>

<label class="flex flex-col gap-1 text-xs">
  Topic angles
  <TagListInput bind:value={tags} placeholder="Add an angle and press Enter" />
</label>
