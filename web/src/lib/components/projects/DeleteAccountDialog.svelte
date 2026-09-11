<script lang="ts">
  import { page } from '$app/stores';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { t, type Locale } from '$lib/i18n/index.js';

  const locale = $derived($page.data.locale as Locale);

  type Props = {
    open: boolean;
    name: string;
    onConfirm: () => void | Promise<void>;
    onClose: () => void;
  };
  let { open = $bindable(), name, onConfirm, onClose }: Props = $props();
  let typed = $state('');
  let busy = $state(false);

  // The warning mentions the account handle twice (once as the credential
  // being deleted, once as the confirmation target), each wrapped in its
  // own <code> element - `splitAroundToken` only ever splits on one marker,
  // so the template carries two distinct marker names for the same value
  // and this does the splitting by hand instead.
  const warningParts = $derived.by(() => {
    const template = t(locale, 'projects.delete-account-warning');
    const marker1 = '{name1}';
    const marker2 = '{name2}';
    const i1 = template.indexOf(marker1);
    const i2 = template.indexOf(marker2);
    return {
      before: template.slice(0, i1),
      between: template.slice(i1 + marker1.length, i2),
      after: template.slice(i2 + marker2.length),
    };
  });

  async function confirm() {
    if (typed !== name || busy) return;
    busy = true;
    try {
      await onConfirm();
    } finally {
      busy = false;
    }
  }
</script>

{#if open}
  <div
    class="fixed inset-0 bg-overlay/40 z-40"
    onclick={onClose}
    role="button"
    tabindex="-1"
    aria-label={t(locale, 'projects.aria-close-dialog')}
    onkeydown={(e) => e.key === 'Escape' && onClose()}
  ></div>
  <div class="fixed inset-0 z-50 flex items-center justify-center p-4 pointer-events-none">
    <div class="bg-background border border-border rounded-lg p-6 w-full max-w-md pointer-events-auto space-y-4">
      <h3 class="font-medium">{t(locale, 'projects.delete-account-title')}</h3>
      <p class="text-sm text-muted-foreground">
        {warningParts.before}<code class="bg-muted px-1 rounded">{name}</code
        >{warningParts.between}<code class="bg-muted px-1 rounded">{name}</code>{warningParts.after}
      </p>
      <label class="flex flex-col gap-1 text-xs">
        {t(locale, 'projects.handle-label')}
        <Input bind:value={typed} />
      </label>
      <div class="flex justify-end gap-2">
        <Button variant="ghost" type="button" onclick={onClose}>{t(locale, 'projects.cancel-button')}</Button>
        <Button
          type="button"
          variant="destructive"
          disabled={typed !== name}
          loading={busy}
          onclick={confirm}
        >
          {t(locale, 'projects.delete-account-button')}
        </Button>
      </div>
    </div>
  </div>
{/if}
