<script lang="ts">
  import * as Dialog from '$lib/components/ui/dialog';
  import { Button } from '$lib/components/ui/button';
  import { Textarea } from '$lib/components/ui/textarea';
  import { page } from '$app/stores';
  import { t, type Locale } from '$lib/i18n/index.js';
  import { toast } from 'svelte-sonner';

  type Props = {
    open: boolean;
    onOpenChange: (v: boolean) => void;
    campaignId: number;
    initialObjective?: string;
    onLaunched: (runId: number) => void;
  };
  let { open, onOpenChange, campaignId, initialObjective, onLaunched }: Props = $props();

  const locale = $derived($page.data.locale as Locale);

  // svelte-ignore state_referenced_locally
  let objective = $state(initialObjective ?? '');
  let submitting = $state(false);

  async function submit() {
    if (!objective.trim()) {
      toast.error(t(locale, 'campaigns.regenerate-dialog.error-objective-required'));
      return;
    }
    submitting = true;
    try {
      const res = await fetch(`/api/campaigns/${campaignId}/skill-runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ objective }),
      });
      const body = await res.json();
      if (res.status === 409) {
        toast.error(t(locale, 'campaigns.regenerate-dialog.error-already-running'));
        return;
      }
      if (!res.ok) {
        toast.error(body.message ?? t(locale, 'campaigns.regenerate-dialog.error-start-failed'));
        return;
      }
      toast.success(t(locale, 'campaigns.regenerate-dialog.toast-started', { run: body.runId }));
      onLaunched(body.runId);
      onOpenChange(false);
    } finally {
      submitting = false;
    }
  }
</script>

<Dialog.Root {open} {onOpenChange}>
  <Dialog.Content>
    <Dialog.Header>
      <Dialog.Title>{t(locale, 'campaigns.regenerate-dialog.title')}</Dialog.Title>
      <Dialog.Description>
        {t(locale, 'campaigns.regenerate-dialog.description')}
      </Dialog.Description>
    </Dialog.Header>
    <Textarea bind:value={objective} rows={6} />
    <Dialog.Footer>
      <Button variant="ghost" onclick={() => onOpenChange(false)} disabled={submitting}>
        {t(locale, 'campaigns.cancel')}
      </Button>
      <Button onclick={submit} loading={submitting}>{t(locale, 'campaigns.regenerate-dialog.run-button')}</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
