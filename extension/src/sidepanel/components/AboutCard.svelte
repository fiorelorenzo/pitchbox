<!-- About card: version + external links. -->
<script lang="ts">
  import { Card, CardContent, CardHeader, CardTitle } from '$ui/card';
  import { t } from '$ext/i18n';

  // VITE_APP_VERSION is injected via `define` in vite.config.ts.
  const VERSION: string = (import.meta.env.VITE_APP_VERSION as string) ?? '0.0.0';
</script>

<Card>
  <CardHeader><CardTitle>{$t('settings.about.title')}</CardTitle></CardHeader>
  <CardContent class="flex flex-col gap-2 text-sm">
    <div class="flex justify-between">
      <span class="text-muted-foreground">{$t('settings.about.version')}</span>
      <span>{VERSION}</span>
    </div>
    <a
      class="underline text-primary"
      href="https://github.com/fiorelorenzo/pitchbox"
      target="_blank"
      rel="noreferrer"
    >
      {$t('settings.about.github')}
    </a>
  </CardContent>
</Card>
