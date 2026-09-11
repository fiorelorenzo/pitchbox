<script lang="ts">
  import { Textarea } from '$lib/components/ui/textarea';
  import { page } from '$app/stores';
  import { t, type Locale } from '$lib/i18n/index.js';
  type Props = { value: string; onChange: (v: string) => void; disabled?: boolean };
  let { value, onChange, disabled = false }: Props = $props();

  const locale = $derived($page.data.locale as Locale);
</script>

<div class="space-y-2">
  <h3 class="text-sm font-medium">{t(locale, 'campaigns.forms.system-instructions.title')}</h3>
  <Textarea
    {value}
    {disabled}
    rows={6}
    oninput={(e) => onChange((e.currentTarget as HTMLTextAreaElement).value)}
    placeholder={t(locale, 'campaigns.forms.system-instructions.placeholder')}
  />
</div>
