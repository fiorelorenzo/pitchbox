<script lang="ts">
  import { page } from '$app/stores';
  import * as Dialog from '$lib/components/ui/dialog';
  import { Button } from '$lib/components/ui/button';
  import { diffLines, type Change } from 'diff';
  import { t, type Locale } from '$lib/i18n/index.js';

  const locale = $derived($page.data.locale as Locale);

  type Props = {
    open: boolean;
    onOpenChange: (v: boolean) => void;
    before: string;
    after: string;
    /** #434: when both are supplied, the modal shows Accept/Decline actions
     * instead of being a read-only "here's what changed" view - used for a
     * description proposal that has not been applied yet. Omit both to keep
     * the original post-hoc usage (an already-applied extraction's diff). */
    onAccept?: () => void | Promise<void>;
    onDecline?: () => void | Promise<void>;
  };
  let { open, onOpenChange, before, after, onAccept, onDecline }: Props = $props();

  let parts = $derived<Change[]>(diffLines(before ?? '', after ?? ''));
  let deciding = $state<'accept' | 'decline' | null>(null);

  async function accept() {
    if (!onAccept) return;
    deciding = 'accept';
    try {
      await onAccept();
    } finally {
      deciding = null;
    }
  }

  async function decline() {
    if (!onDecline) return;
    deciding = 'decline';
    try {
      await onDecline();
    } finally {
      deciding = null;
    }
  }
</script>

<Dialog.Root {open} {onOpenChange}>
  <Dialog.Content class="max-w-3xl">
    <Dialog.Header><Dialog.Title>{t(locale, 'projects.description-diff-title')}</Dialog.Title></Dialog.Header>
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
    {#if onAccept || onDecline}
      <Dialog.Footer>
        <Button variant="ghost" onclick={decline} loading={deciding === 'decline'} disabled={!!deciding}>
          {t(locale, 'projects.decline-button')}
        </Button>
        <Button onclick={accept} loading={deciding === 'accept'} disabled={!!deciding}
          >{t(locale, 'projects.accept-button')}</Button
        >
      </Dialog.Footer>
    {/if}
  </Dialog.Content>
</Dialog.Root>
