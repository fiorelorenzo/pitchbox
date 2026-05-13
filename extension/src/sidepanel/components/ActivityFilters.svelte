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

  const levels: { value: ActivityLevel | 'all'; label: string }[] = [
    { value: 'all', label: 'All' },
    { value: 'info', label: 'Info' },
    { value: 'warn', label: 'Warn' },
    { value: 'error', label: 'Error' },
  ];
  const sources: { value: ActivitySource | 'all'; label: string }[] = [
    { value: 'all', label: 'All' },
    { value: 'pairing', label: 'pairing' },
    { value: 'dm-sync', label: 'dm-sync' },
    { value: 'chat-sync', label: 'chat-sync' },
    { value: 'matrix-token', label: 'matrix-token' },
    { value: 'reddit-action', label: 'reddit-action' },
    { value: 'settings', label: 'settings' },
    { value: 'system', label: 'system' },
  ];
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
