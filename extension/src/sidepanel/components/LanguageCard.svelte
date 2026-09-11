<!-- Language settings: locale selector with live re-render. -->
<script lang="ts">
  import { onMount } from 'svelte';
  import { Card, CardContent, CardHeader, CardTitle } from '$ui/card';
  import { SelectField } from '$ui/select-field';
  import { t, setLocale } from '$ext/i18n';
  import { getSettings, setSettings, type LocaleCode } from '$ext/settings';
  import { api } from '$ext/api';

  let locale = $state<LocaleCode>('en');

  onMount(async () => {
    locale = (await getSettings()).locale;
  });

  // LOR-262: writes through to the account, not just this device's local
  // cache - best-effort (`api.syncLocale` never throws, see api.ts), since
  // local storage stays authoritative for this install regardless of
  // whether the account write lands. A device with no bound user (self-host,
  // a code-redeemed pairing, or simply offline) reports `synced: false` and
  // the picker stays exactly as responsive either way.
  async function onLocale(next: LocaleCode) {
    locale = next;
    setLocale(next);
    await setSettings({ locale: next });
    void api.syncLocale(next);
  }
</script>

<Card>
  <CardHeader><CardTitle>{$t('settings.language.title')}</CardTitle></CardHeader>
  <CardContent>
    <label class="flex flex-col gap-1 text-xs text-muted-foreground">
      <span>{$t('settings.language.locale')}</span>
      <SelectField
        value={locale}
        onValueChange={onLocale}
        fullWidth
        size="sm"
        options={[
          { value: 'en', label: $t('settings.language.option.en') },
          { value: 'it', label: $t('settings.language.option.it') },
        ]}
      />
    </label>
  </CardContent>
</Card>
