<script lang="ts">
  import { Input } from '$lib/components/ui/input';
  import { SelectField } from '$lib/components/ui/select-field';
  import TagListInput from '$lib/components/projects/TagListInput.svelte';
  import { page } from '$app/stores';
  import { t, type Locale } from '$lib/i18n/index.js';

  type V = {
    tone: 'casual' | 'neutral' | 'professional';
    hardBans: string[];
    dos: string[];
    disclosure: string;
  };
  type Props = { value: V; onChange: (v: V) => void; disabled?: boolean };
  let { value, onChange, disabled = false }: Props = $props();

  const locale = $derived($page.data.locale as Locale);
  function patch(p: Partial<V>) {
    onChange({ ...value, ...p });
  }
</script>

<div class="space-y-3">
  <h3 class="text-sm font-medium">{t(locale, 'campaigns.forms.voice-title')}</h3>
  <label class="flex flex-col gap-1 text-xs">
    {t(locale, 'campaigns.forms.field-tone')}
    <SelectField
      value={value.tone}
      onValueChange={(v) => patch({ tone: v as V['tone'] })}
      options={[
        { value: 'casual', label: t(locale, 'campaigns.forms.tone-casual') },
        { value: 'neutral', label: t(locale, 'campaigns.forms.tone-neutral') },
        { value: 'professional', label: t(locale, 'campaigns.forms.tone-professional') },
      ]}
      {disabled}
      fullWidth
    />
  </label>
  <label class="flex flex-col gap-1 text-xs">
    {t(locale, 'campaigns.forms.field-hard-bans')}
    <TagListInput
      value={value.hardBans}
      onChange={(v) => patch({ hardBans: v })}
      {disabled}
    />
  </label>
  <label class="flex flex-col gap-1 text-xs">
    {t(locale, 'campaigns.forms.field-dos')}
    <TagListInput
      value={value.dos}
      onChange={(v) => patch({ dos: v })}
      {disabled}
    />
  </label>
  <label class="flex flex-col gap-1 text-xs">
    {t(locale, 'campaigns.forms.field-disclosure')}
    <Input
      value={value.disclosure}
      {disabled}
      oninput={(e) => patch({ disclosure: (e.currentTarget as HTMLInputElement).value })}
    />
  </label>
</div>
