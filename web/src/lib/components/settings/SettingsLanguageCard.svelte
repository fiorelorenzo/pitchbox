<script lang="ts">
  import * as Card from '$lib/components/ui/card';
  import { Languages } from '@lucide/svelte';
  import { SelectField } from '$lib/components/ui/select-field';
  import { toast } from 'svelte-sonner';
  import { invalidateAll } from '$app/navigation';
  import { page } from '$app/stores';
  import type { Locale } from '$lib/i18n.js';
  import { t } from '$lib/i18n/index.js';

  const locale = $derived($page.data.locale as Locale);

  const LOCALE_OPTIONS: { value: Locale; label: string }[] = [
    { value: 'en', label: 'English' },
    { value: 'it', label: 'Italiano' },
  ];
  // svelte-ignore state_referenced_locally
  let localeVal = $state<Locale>(locale);
  let saving = $state(false);

  // LOR-262: the account's language override, folded from its own
  // /settings/language page into a General card (2026-09-12 UI/UX defects
  // batch). One account, one value - this is the surface
  // docs/design/DECISIONS.md D46 and web/src/lib/i18n.ts's module doc
  // comment both point at: the extension's own Settings picker writes
  // through to the same `users.locale` column via
  // POST /api/extension/locale, so changing it here is what that picker
  // reads back on its next handshake, and vice versa.
  async function saveLocale(next: Locale) {
    const previous = localeVal;
    localeVal = next;
    saving = true;
    try {
      const res = await fetch('/api/auth/locale', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ locale: next }),
      });
      if (!res.ok) {
        localeVal = previous;
        toast.error(t(locale, 'settings.general.language.error-save-failed'));
        return;
      }
      toast.success(t(locale, 'settings.general.language.success-saved'));
      // Re-runs every load function for this request, hooks.server.ts
      // included - the very next request picks up the account preference
      // this just wrote, so <html lang> and every loader agree immediately
      // rather than waiting for the next navigation.
      await invalidateAll();
    } catch {
      localeVal = previous;
      toast.error(t(locale, 'settings.general.language.error-save-failed'));
    } finally {
      saving = false;
    }
  }
</script>

<Card.Root size="sm">
  <Card.Header class="flex flex-row flex-nowrap items-center gap-2 space-y-0">
    <Languages class="size-4 shrink-0 text-muted-foreground" />
    <Card.Title class="text-base min-w-0 flex-1 truncate"
      >{t(locale, 'settings.general.language.title')}</Card.Title
    >
  </Card.Header>
  <Card.Content class="max-w-xs">
    <SelectField
      value={localeVal}
      onValueChange={(v) => saveLocale(v as Locale)}
      options={LOCALE_OPTIONS}
      disabled={saving}
      fullWidth
    />
    <p class="mt-2 text-xs text-muted-foreground">
      {t(locale, 'settings.general.language.description')}
    </p>
  </Card.Content>
</Card.Root>
