<!-- Language settings: locale selector with live re-render. -->
<script lang="ts">
  import { onMount } from 'svelte';
  import { Card, CardContent, CardHeader, CardTitle } from '$ui/card';
  import { SelectField } from '$ui/select-field';
  import { t, setLocale } from '$ext/i18n';
  import { getSettings, setSettings, type LocaleCode } from '$ext/settings';

  let locale = $state<LocaleCode>('en');

  onMount(async () => {
    locale = (await getSettings()).locale;
  });

  async function onLocale(next: LocaleCode) {
    locale = next;
    setLocale(next);
    await setSettings({ locale: next });
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
          { value: 'en', label: 'English' },
          { value: 'it', label: 'Italiano' },
        ]}
      />
    </label>
  </CardContent>
</Card>
