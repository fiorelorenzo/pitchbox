<script lang="ts">
  import * as Dialog from '$lib/components/ui/dialog';
  import { diffLines, type Change } from 'diff';

  type Props = {
    open: boolean;
    onOpenChange: (v: boolean) => void;
    before: string;
    after: string;
  };
  let { open, onOpenChange, before, after }: Props = $props();

  let parts = $derived<Change[]>(diffLines(before ?? '', after ?? ''));
</script>

<Dialog.Root {open} {onOpenChange}>
  <Dialog.Content class="max-w-3xl">
    <Dialog.Header><Dialog.Title>Description diff</Dialog.Title></Dialog.Header>
    <pre class="text-xs font-mono whitespace-pre-wrap max-h-[60vh] overflow-auto">
      {#each parts as p, i (i)}
        <span
          class={p.added
            ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
            : p.removed
              ? 'bg-rose-500/15 text-rose-700 dark:text-rose-300 line-through'
              : ''}
        >{p.value}</span>
      {/each}
    </pre>
  </Dialog.Content>
</Dialog.Root>
