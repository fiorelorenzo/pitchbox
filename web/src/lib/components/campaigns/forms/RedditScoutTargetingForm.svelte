<script lang="ts">
  import { Input } from '$lib/components/ui/input';
  import TagListInput from '$lib/components/projects/TagListInput.svelte';
  import { page } from '$app/stores';
  import { t, type Locale } from '$lib/i18n/index.js';

  type V = {
    targetSubreddits: string[];
    topicKeywords: string[];
    avoidKeywords: string[];
    fitScoreThreshold: number;
  };
  type Props = { value: V; onChange: (v: V) => void; disabled?: boolean };
  let { value, onChange, disabled = false }: Props = $props();

  const locale = $derived($page.data.locale as Locale);

  function patch(p: Partial<V>) {
    onChange({ ...value, ...p });
  }
</script>

<div class="space-y-3">
  <h3 class="text-sm font-medium">{t(locale, 'campaigns.forms.targeting-title')}</h3>
  <label class="flex flex-col gap-1 text-xs">
    {t(locale, 'campaigns.forms.field-target-subreddits')}
    <TagListInput
      value={value.targetSubreddits}
      onChange={(v) => patch({ targetSubreddits: v })}
      {disabled}
      placeholder={t(locale, 'campaigns.forms.placeholder-rpg')}
    />
  </label>
  <label class="flex flex-col gap-1 text-xs">
    {t(locale, 'campaigns.forms.field-topic-keywords')}
    <TagListInput
      value={value.topicKeywords}
      onChange={(v) => patch({ topicKeywords: v })}
      {disabled}
      placeholder={t(locale, 'campaigns.forms.targeting.placeholder-topic-keywords-scout')}
    />
  </label>
  <label class="flex flex-col gap-1 text-xs">
    {t(locale, 'campaigns.forms.field-avoid-keywords')}
    <TagListInput
      value={value.avoidKeywords}
      onChange={(v) => patch({ avoidKeywords: v })}
      {disabled}
      placeholder={t(locale, 'campaigns.forms.placeholder-spam')}
    />
  </label>
  <label class="flex flex-col gap-1 text-xs">
    {t(locale, 'campaigns.forms.targeting.field-fit-score')}
    <Input
      type="number"
      min={1}
      max={5}
      value={value.fitScoreThreshold}
      {disabled}
      oninput={(e) =>
        patch({ fitScoreThreshold: Number((e.currentTarget as HTMLInputElement).value) })}
    />
  </label>
</div>
