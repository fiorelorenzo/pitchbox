<script lang="ts">
  import { Textarea } from '$lib/components/ui/textarea';
  import { page } from '$app/stores';
  import { t, type Locale } from '$lib/i18n/index.js';

  type Props = {
    value: string;
    onChange: (v: string) => void;
    disabled?: boolean;
  };
  let { value, onChange, disabled = false }: Props = $props();

  const locale = $derived($page.data.locale as Locale);
</script>

<section class="space-y-2">
  <header>
    <h3 class="text-sm font-semibold">{t(locale, 'campaigns.forms.angle.title')}</h3>
    <p class="text-xs text-muted-foreground">
      {t(locale, 'campaigns.forms.angle.description')}
    </p>
  </header>
  <Textarea
    value={value}
    oninput={(e) => onChange(e.currentTarget.value)}
    rows={3}
    {disabled}
    class="text-sm"
  />
</section>
