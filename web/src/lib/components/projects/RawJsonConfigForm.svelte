<script lang="ts">
  import { Textarea } from '$lib/components/ui/textarea';

  type Props = { value: unknown; onChange: (v: unknown) => void };
  let { value, onChange }: Props = $props();
  // svelte-ignore state_referenced_locally
  let text = $state(JSON.stringify(value ?? null, null, 2));
  let parseError = $state<string | null>(null);

  function tryParse() {
    try {
      const v = JSON.parse(text);
      parseError = null;
      onChange(v);
    } catch (err) {
      parseError = (err as Error).message;
    }
  }
</script>

<Textarea bind:value={text} rows={10} class="font-mono text-xs" oninput={tryParse} />
{#if parseError}
  <p class="text-xs text-destructive mt-1">{parseError}</p>
{/if}
