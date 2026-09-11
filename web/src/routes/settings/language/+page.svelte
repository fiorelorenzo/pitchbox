<script lang="ts">
  import * as Card from '$lib/components/ui/card';
  import { SelectField } from '$lib/components/ui/select-field';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import Seo from '$lib/components/Seo.svelte';
  import PageContainer from '$lib/components/PageContainer.svelte';
  import { toast } from 'svelte-sonner';
  import { invalidateAll } from '$app/navigation';
  import type { Locale } from '$lib/i18n.js';

  type PageData = { locale: Locale };
  let { data }: { data: PageData } = $props();

  const LOCALE_OPTIONS: { value: Locale; label: string }[] = [
    { value: 'en', label: 'English' },
    { value: 'it', label: 'Italiano' },
  ];

  // svelte-ignore state_referenced_locally
  let locale = $state<Locale>(data.locale);
  let saving = $state(false);

  // LOR-262: the account's language override. One account, one value - this
  // is the surface `docs/design/DECISIONS.md` D46 and web/src/lib/i18n.ts's
  // module doc comment both point at: the extension's own Settings picker
  // writes through to the same `users.locale` column via
  // POST /api/extension/locale, so changing it here is what that picker
  // reads back on its next handshake, and vice versa.
  async function saveLocale(next: Locale) {
    const previous = locale;
    locale = next;
    saving = true;
    try {
      const res = await fetch('/api/auth/locale', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ locale: next }),
      });
      if (!res.ok) {
        locale = previous;
        toast.error('Could not save the language');
        return;
      }
      toast.success('Language saved');
      // Re-runs every load function for this request, hooks.server.ts
      // included - the very next request picks up the account preference
      // this just wrote, so <html lang> and every loader agree immediately
      // rather than waiting for the next navigation.
      await invalidateAll();
    } catch {
      locale = previous;
      toast.error('Could not save the language');
    } finally {
      saving = false;
    }
  }
</script>

<Seo title="Settings - Language" description="Choose the dashboard's display language." />

<PageHeader
  title="Language"
  description="Applies to the dashboard and, on its next handshake, the browser extension - one account setting, not one per surface."
/>

<div class="mt-4 grid gap-4">
  <Card.Root>
    <Card.Header>
      <Card.Title>Display language</Card.Title>
      <Card.Description>
        Signed-out pages keep using your browser's language until you sign in.
      </Card.Description>
    </Card.Header>
    <Card.Content class="max-w-xs">
      <SelectField
        value={locale}
        onValueChange={(v) => saveLocale(v as Locale)}
        options={LOCALE_OPTIONS}
        disabled={saving}
        fullWidth
      />
    </Card.Content>
  </Card.Root>
</div>
