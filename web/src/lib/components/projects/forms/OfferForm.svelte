<script lang="ts">
  import { Input } from '$lib/components/ui/input';

  type V = { name: string; cta: string; composeSubject: string; url?: string };
  type Props = { value: V; onChange: (v: V) => void };
  let { value, onChange }: Props = $props();
  // svelte-ignore state_referenced_locally
  let name = $state(value.name ?? '');
  // svelte-ignore state_referenced_locally
  let cta = $state(value.cta ?? '');
  // svelte-ignore state_referenced_locally
  let subject = $state(value.composeSubject ?? '');
  // svelte-ignore state_referenced_locally
  let url = $state(value.url ?? '');
  $effect(() => onChange({ name, cta, composeSubject: subject, url: url || undefined }));
</script>

<div class="space-y-3">
  <label class="flex flex-col gap-1 text-xs">Name<Input bind:value={name} /></label>
  <label class="flex flex-col gap-1 text-xs">CTA<Input bind:value={cta} /></label>
  <label class="flex flex-col gap-1 text-xs">Compose subject<Input bind:value={subject} /></label>
  <label class="flex flex-col gap-1 text-xs">URL (optional)<Input type="url" bind:value={url} /></label>
</div>
