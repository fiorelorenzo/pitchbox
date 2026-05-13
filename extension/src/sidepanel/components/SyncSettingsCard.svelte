<!-- Sync settings: poller interval + per-poller toggles. SW reacts via chrome.storage.onChanged. -->
<script lang="ts">
  import { onMount } from 'svelte';
  import { Card, CardContent, CardHeader, CardTitle } from '$ui/card';
  import { Switch } from '$ui/switch';
  import { SelectField } from '$ui/select-field';
  import { t } from '$ext/i18n';
  import { getSettings, setSettings, type SyncIntervalMin } from '$ext/settings';

  let interval = $state<SyncIntervalMin>(10);
  let legacy = $state(true);
  let chat = $state(true);

  onMount(async () => {
    const s = await getSettings();
    interval = s.syncIntervalMin;
    legacy = s.legacyPollerEnabled;
    chat = s.chatPollerEnabled;
  });

  async function onInterval(v: SyncIntervalMin) {
    interval = v;
    await setSettings({ syncIntervalMin: v });
  }

  async function onLegacy(v: boolean) {
    legacy = v;
    await setSettings({ legacyPollerEnabled: v });
  }

  async function onChat(v: boolean) {
    chat = v;
    await setSettings({ chatPollerEnabled: v });
  }
</script>

<Card>
  <CardHeader><CardTitle>{$t('settings.sync.title')}</CardTitle></CardHeader>
  <CardContent class="flex flex-col gap-4">
    <label class="flex flex-col gap-1 text-xs text-muted-foreground">
      <span>{$t('settings.sync.interval')}</span>
      <SelectField
        value={interval}
        onValueChange={onInterval}
        fullWidth
        size="sm"
        options={[
          { value: 5, label: $t('settings.sync.interval.5') },
          { value: 10, label: $t('settings.sync.interval.10') },
          { value: 15, label: $t('settings.sync.interval.15') },
          { value: 30, label: $t('settings.sync.interval.30') },
        ]}
      />
    </label>
    <label class="flex items-center justify-between gap-2 text-sm">
      <span>{$t('settings.sync.legacy')}</span>
      <Switch checked={legacy} onCheckedChange={onLegacy} />
    </label>
    <label class="flex items-center justify-between gap-2 text-sm">
      <span>{$t('settings.sync.chat')}</span>
      <Switch checked={chat} onCheckedChange={onChat} />
    </label>
  </CardContent>
</Card>
