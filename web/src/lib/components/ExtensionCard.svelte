<script lang="ts">
  import * as Card from '$lib/components/ui/card';
  import { Puzzle } from '@lucide/svelte';
  import { page } from '$app/stores';
  import { t, type Locale } from '$lib/i18n/index.js';

  type Props = {
    backendUrl: string;
  };
  let { backendUrl }: Props = $props();
  const locale = $derived($page.data.locale as Locale);
</script>

<Card.Root size="sm">
  <Card.Header class="flex flex-row flex-nowrap items-center gap-2 space-y-0">
    <Puzzle class="size-4 shrink-0 text-muted-foreground" />
    <Card.Title class="text-base min-w-0 flex-1 truncate"
      >{t(locale, 'settings.extension.card.title')}</Card.Title
    >
  </Card.Header>
  <Card.Content class="flex flex-col gap-3 text-sm">
    <p class="text-xs text-muted-foreground">
      {t(locale, 'settings.extension.card.description-lead')}
      <code class="text-xs">sent</code>
      {t(locale, 'settings.extension.card.description-tail')}
    </p>

    <div class="rounded-md border border-border/60 px-3 py-2 text-xs">
      <p class="font-medium">{t(locale, 'settings.extension.card.pair-heading')}</p>
      <ol class="mt-1.5 list-inside list-decimal space-y-1 text-muted-foreground">
        <li>{t(locale, 'settings.extension.card.pair-step-1')}</li>
        <li>
          {t(locale, 'settings.extension.card.pair-step-2-lead')}
          <strong>Dashboard</strong>
          {t(locale, 'settings.extension.card.pair-step-2-tail')}
          <em>Pair with this tab</em>.
        </li>
        <li>{t(locale, 'settings.extension.card.pair-step-3')}</li>
      </ol>
      <p class="mt-2 text-muted-foreground">
        {t(locale, 'settings.extension.card.pair-footer')}
      </p>
    </div>

    <details class="text-xs text-muted-foreground">
      <summary class="cursor-pointer select-none"
        >{t(locale, 'settings.extension.card.install-summary')}</summary
      >
      <ol class="mt-2 list-inside list-decimal space-y-1">
        <li>
          {t(locale, 'settings.extension.card.install-step-1-lead')}
          <code>pnpm run build:extension</code>.
        </li>
        <li>
          {t(locale, 'settings.extension.card.install-step-2-lead')}
          <code>chrome://extensions</code>{t(locale, 'settings.extension.card.install-step-2-tail')}
          <em>Developer mode</em>.
        </li>
        <li>
          {t(locale, 'settings.extension.card.install-step-3-lead')}
          <em>Load unpacked</em>
          {t(locale, 'settings.extension.card.install-step-3-tail')}
          <code>extension/dist/</code>.
        </li>
        <li>{t(locale, 'settings.extension.card.install-step-4')}</li>
      </ol>
      <div class="mt-2">
        <div>
          {t(locale, 'settings.extension.card.backend-url-lead')}
          <em>Add connection</em>
          {t(locale, 'settings.extension.card.backend-url-tail')}
          <code class="font-mono">{backendUrl}</code>
        </div>
      </div>
    </details>
  </Card.Content>
</Card.Root>
