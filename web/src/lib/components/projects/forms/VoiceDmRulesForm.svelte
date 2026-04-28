<script lang="ts">
  import { Textarea } from '$lib/components/ui/textarea';
  import TagListInput from '../TagListInput.svelte';

  type V = { hardBans: string[]; dos: string[]; disclosure: string; examples: string[] };
  type Props = { value: V; onChange: (v: V) => void };
  let { value, onChange }: Props = $props();
  // svelte-ignore state_referenced_locally
  let hardBans = $state<string[]>(value.hardBans ?? []);
  // svelte-ignore state_referenced_locally
  let dos = $state<string[]>(value.dos ?? []);
  // svelte-ignore state_referenced_locally
  let disclosure = $state(value.disclosure ?? '');
  // svelte-ignore state_referenced_locally
  let examples = $state<string[]>(value.examples ?? []);
  $effect(() => onChange({ hardBans, dos, disclosure, examples }));
</script>

<div class="space-y-3">
  <label class="flex flex-col gap-1 text-xs">Hard bans<TagListInput bind:value={hardBans} /></label>
  <label class="flex flex-col gap-1 text-xs">Do's<TagListInput bind:value={dos} /></label>
  <label class="flex flex-col gap-1 text-xs">Disclosure<Textarea bind:value={disclosure} rows={2} /></label>
  <label class="flex flex-col gap-1 text-xs">Examples<TagListInput bind:value={examples} placeholder="Paste example DM" /></label>
</div>
