<script lang="ts">
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { page } from '$app/stores';
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
    aria-label={t(locale, 'settings.organization.close-dialog-aria')}
    onkeydown={(e) => e.key === 'Escape' && onClose()}
  ></div>
  <div class="fixed inset-0 z-50 flex items-center justify-center p-4 pointer-events-none">
    <div class="bg-background border border-border rounded-lg p-6 w-full max-w-md pointer-events-auto space-y-4">
      <h3 class="font-medium">{t(locale, 'settings.organization.leave-org-title')}</h3>
      <p class="text-sm text-muted-foreground">
        {t(locale, 'settings.organization.leave-dialog-description-lead')}
        <code class="bg-muted px-1 rounded">{name}</code>
        {t(locale, 'settings.organization.leave-dialog-description-mid')}
        <code class="bg-muted px-1 rounded">{name}</code>
        {t(locale, 'settings.organization.leave-dialog-description-tail')}
      </p>
      <label class="flex flex-col gap-1 text-xs">
        {t(locale, 'settings.organization.org-name-label')}
        <Input bind:value={typed} />
      </label>
      <div class="flex justify-end gap-2">
        <Button variant="ghost" type="button" onclick={onClose}
          >{t(locale, 'settings.organization.cancel')}</Button
        >
        <Button
          type="button"
          variant="destructive"
          disabled={typed !== name}
          loading={busy}
          onclick={confirm}
        >
          {t(locale, 'settings.organization.leave-org-title')}
        </Button>
      </div>
    </div>
  </div>
{/if}
