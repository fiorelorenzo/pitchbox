<script lang="ts">
  import { Input } from '$lib/components/ui/input';
  import TagListInput from '$lib/components/projects/TagListInput.svelte';
  import { page } from '$app/stores';
  import { t, type Locale } from '$lib/i18n/index.js';

  type V = { valuePropositions: string[]; productUrl: string };
  type Props = { value: V; onChange: (v: V) => void; disabled?: boolean };
  let { value, onChange, disabled = false }: Props = $props();

  const locale = $derived($page.data.locale as Locale);
  function patch(p: Partial<V>) {
    onChange({ ...value, ...p });
  }
</script>

<div class="space-y-3">
  <h3 class="text-sm font-medium">{t(locale, 'campaigns.forms.value.title')}</h3>
  <label class="flex flex-col gap-1 text-xs">
    {t(locale, 'campaigns.forms.value.field-value-propositions')}
    <TagListInput
      value={value.valuePropositions}
      onChange={(v) => patch({ valuePropositions: v })}
      {disabled}
      placeholder={t(locale, 'campaigns.forms.value.placeholder-value-propositions')}
    />
  </label>
  <label class="flex flex-col gap-1 text-xs">
    {t(locale, 'campaigns.forms.field-product-url')}
    <Input
      value={value.productUrl}
      {disabled}
      oninput={(e) => patch({ productUrl: (e.currentTarget as HTMLInputElement).value })}
    />
  </label>
</div>
