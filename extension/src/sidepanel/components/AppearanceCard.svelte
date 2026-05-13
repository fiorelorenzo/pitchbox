<!-- Appearance settings: theme + density. -->
<script lang="ts">
  import { onMount } from 'svelte';
  import { Card, CardContent, CardHeader, CardTitle } from '$ui/card';
  import { SelectField } from '$ui/select-field';
  import { t } from '$ext/i18n';
  import { getSettings, setSettings, type ThemeMode, type Density } from '$ext/settings';
  import { applyTheme } from '$ext/theme';

  let theme = $state<ThemeMode>('system');
  let density = $state<Density>('comfortable');

  onMount(async () => {
    const s = await getSettings();
    theme = s.theme;
    density = s.density;
  });

  async function onTheme(next: ThemeMode) {
    theme = next;
    applyTheme(next);
    await setSettings({ theme: next });
  }

  async function onDensity(next: Density) {
    density = next;
    document.documentElement.classList.toggle('density-compact', next === 'compact');
    await setSettings({ density: next });
  }
</script>

<Card>
  <CardHeader><CardTitle>{$t('settings.appearance.title')}</CardTitle></CardHeader>
  <CardContent class="flex flex-col gap-3">
    <label class="flex flex-col gap-1 text-xs text-muted-foreground">
      <span>{$t('settings.appearance.theme')}</span>
      <SelectField
        value={theme}
        onValueChange={onTheme}
        fullWidth
        size="sm"
        options={[
          { value: 'light', label: $t('settings.appearance.theme.light') },
          { value: 'dark', label: $t('settings.appearance.theme.dark') },
          { value: 'system', label: $t('settings.appearance.theme.system') },
        ]}
      />
    </label>
    <label class="flex flex-col gap-1 text-xs text-muted-foreground">
      <span>{$t('settings.appearance.density')}</span>
      <SelectField
        value={density}
        onValueChange={onDensity}
        fullWidth
        size="sm"
        options={[
          { value: 'compact', label: $t('settings.appearance.density.compact') },
          { value: 'comfortable', label: $t('settings.appearance.density.comfortable') },
        ]}
      />
    </label>
  </CardContent>
</Card>
