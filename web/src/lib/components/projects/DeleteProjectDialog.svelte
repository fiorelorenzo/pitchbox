<script lang="ts">
  import { page } from '$app/stores';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { t, splitAroundToken, type Locale } from '$lib/i18n/index.js';

  const locale = $derived($page.data.locale as Locale);

  type Props = {
    open: boolean;
    slug: string;
    onConfirm: () => void | Promise<void>;
    onClose: () => void;
  };
  let { open = $bindable(), slug, onConfirm, onClose }: Props = $props();
  let typed = $state('');
  let busy = $state(false);

  const [confirmBefore, confirmAfter] = $derived(
    splitAroundToken(locale, 'projects.delete-project-confirm-prompt', 'slug'),
  );

  async function confirm() {
    if (typed !== slug || busy) return;
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
      <h3 class="font-medium">{t(locale, 'projects.delete-project-title')}</h3>
      <p class="text-sm text-muted-foreground">
        {t(locale, 'projects.delete-project-warning')}
        {confirmBefore}<code class="bg-muted px-1 rounded">{slug}</code>{confirmAfter}
      </p>
      <label class="flex flex-col gap-1 text-xs">
        {t(locale, 'projects.slug-label')}
        <Input bind:value={typed} />
      </label>
      <div class="flex justify-end gap-2">
        <Button variant="ghost" type="button" onclick={onClose}>{t(locale, 'projects.cancel-button')}</Button>
        <Button
          type="button"
          variant="destructive"
          disabled={typed !== slug}
          loading={busy}
          onclick={confirm}
        >
          {t(locale, 'projects.delete-project-button')}
        </Button>
      </div>
    </div>
  </div>
{/if}
