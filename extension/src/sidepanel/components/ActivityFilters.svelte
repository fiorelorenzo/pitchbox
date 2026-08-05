<!-- Search + level + source filters for the Activity tab. -->
<script lang="ts">
  import { Input } from '$ui/input';
  import { SelectField } from '$ui/select-field';
  import { t } from '$ext/i18n';
  import { type ActivityLevel, type ActivitySource } from '$ext/activity';

  let {
    search = $bindable(''),
    level = $bindable<ActivityLevel | 'all'>('all'),
    source = $bindable<ActivitySource | 'all'>('all'),
  }: {
    search?: string;
    level?: ActivityLevel | 'all';
    source?: ActivitySource | 'all';
  } = $props();

  let levels: { value: ActivityLevel | 'all'; label: string }[] = $derived([
    { value: 'all', label: $t('activity.level.all') },
    { value: 'info', label: $t('activity.level.info') },
    { value: 'warn', label: $t('activity.level.warn') },
    { value: 'error', label: $t('activity.level.error') },
  ]);
  let sources: { value: ActivitySource | 'all'; label: string }[] = $derived([
    { value: 'all', label: $t('activity.source.all') },
    { value: 'pairing', label: $t('activity.source.pairing') },
    { value: 'dm-sync', label: $t('activity.source.dm-sync') },
    { value: 'chat-sync', label: $t('activity.source.chat-sync') },
    { value: 'matrix-token', label: $t('activity.source.matrix-token') },
    { value: 'reddit-action', label: $t('activity.source.reddit-action') },
    { value: 'settings', label: $t('activity.source.settings') },
    { value: 'system', label: $t('activity.source.system') },
  ]);
</script>

<div class="flex flex-col gap-2">
  <Input bind:value={search} placeholder={$t('activity.filter.search')} />
  <div class="flex gap-2">
    <label class="flex flex-1 flex-col gap-1 text-xs text-muted-foreground">
      <span>{$t('activity.filter.level')}</span>
      <SelectField bind:value={level} options={levels} fullWidth size="sm" />
    </label>
    <label class="flex flex-1 flex-col gap-1 text-xs text-muted-foreground">
      <span>{$t('activity.filter.source')}</span>
      <SelectField bind:value={source} options={sources} fullWidth size="sm" />
    </label>
  </div>
</div>
