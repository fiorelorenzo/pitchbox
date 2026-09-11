<script lang="ts">
  import * as Card from '$lib/components/ui/card';
  import { SelectField } from '$lib/components/ui/select-field';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import Seo from '$lib/components/Seo.svelte';
  import PageContainer from '$lib/components/PageContainer.svelte';
  import { toast } from 'svelte-sonner';
  import { invalidateAll } from '$app/navigation';
  import { page } from '$app/stores';
  import type { Locale } from '$lib/i18n.js';
  import { t } from '$lib/i18n/index.js';

  type PageData = { locale: Locale };
  let { data }: { data: PageData } = $props();

  const locale = $derived($page.data.locale as Locale);

  const LOCALE_OPTIONS: { value: Locale; label: string }[] = [
    { value: 'en', label: 'English' },
    { value: 'it', label: 'Italiano' },
  ];

  // svelte-ignore state_referenced_locally
  let localeVal = $state<Locale>(data.locale);
  let saving = $state(false);

  // LOR-262: the account's language override. One account, one value - this
  // is the surface `docs/design/DECISIONS.md` D46 and web/src/lib/i18n.ts's
  // module doc comment both point at: the extension's own Settings picker
  // writes through to the same `users.locale` column via
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
        toast.error(t(locale, 'settings.language.error-save-failed'));
        return;
      }
      toast.success(t(locale, 'settings.language.success-saved'));
      // Re-runs every load function for this request, hooks.server.ts
      // included - the very next request picks up the account preference
      // this just wrote, so <html lang> and every loader agree immediately
      // rather than waiting for the next navigation.
      await invalidateAll();
    } catch {
      localeVal = previous;
      toast.error(t(locale, 'settings.language.error-save-failed'));
    } finally {
      saving = false;
    }
  }
</script>

<Seo
  title={t(locale, 'settings.language.seo-title')}
  description={t(locale, 'settings.language.seo-description')}
/>

<PageHeader
  title={t(locale, 'settings.language.title')}
  description={t(locale, 'settings.language.description')}
/>

<div class="mt-4 grid gap-4">
  <Card.Root>
    <Card.Header>
      <Card.Title>{t(locale, 'settings.language.display-language-title')}</Card.Title>
      <Card.Description>
        {t(locale, 'settings.language.display-language-description')}
      </Card.Description>
    </Card.Header>
    <Card.Content class="max-w-xs">
      <SelectField
        value={localeVal}
        onValueChange={(v) => saveLocale(v as Locale)}
        options={LOCALE_OPTIONS}
        disabled={saving}
        fullWidth
      />
    </Card.Content>
  </Card.Root>
</div>
