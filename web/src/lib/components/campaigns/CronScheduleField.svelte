<script lang="ts">
  import { Input } from '$lib/components/ui/input';
  import { SelectField } from '$lib/components/ui/select-field';
  import { Button } from '$lib/components/ui/button';
  import { previewCron } from '@pitchbox/daemon/cron';
  import { TONE_TEXT_CLASS } from '$lib/config/status-badges';
  import {
    WEEKDAY_OPTIONS,
    buildHourlyCron,
    buildDailyCron,
    buildWeeklyCron,
    parseTimeInput,
    formatTimeInput,
    detectPreset,
    type CronPresetId,
  } from '$lib/cron-presets';

  type Props = {
    value: string;
    valid?: boolean;
    disabled?: boolean;
    id?: string;
  };
  let { value = $bindable(''), valid = $bindable(true), disabled = false, id }: Props = $props();

  // Seed the preset tab + its params from whatever cron the campaign already
  // has, once, at mount - detectPreset(value) does not stay reactive on
  // purpose, so switching presets or free-typing the raw field afterward
  // never gets silently overwritten by this initial guess.
  const detected = detectPreset(value);
  // svelte-ignore state_referenced_locally
  let preset = $state<CronPresetId>(detected.id);
  // svelte-ignore state_referenced_locally
  let dailyTime = $state(detected.id === 'daily' ? formatTimeInput(detected.hour, detected.minute) : '09:00');
  // svelte-ignore state_referenced_locally
  let weeklyDay = $state(detected.id === 'weekly' ? detected.dayOfWeek : 1);
  // svelte-ignore state_referenced_locally
  let weeklyTime = $state(detected.id === 'weekly' ? formatTimeInput(detected.hour, detected.minute) : '09:00');

  const PRESET_TABS: Array<{ id: CronPresetId; label: string }> = [
    { id: 'hourly', label: 'Hourly' },
    { id: 'daily', label: 'Daily' },
    { id: 'weekly', label: 'Weekly' },
    { id: 'custom', label: 'Custom' },
  ];

  function selectPreset(next: CronPresetId) {
    preset = next;
    if (next === 'hourly') value = buildHourlyCron();
    else if (next === 'daily') {
      const { hour, minute } = parseTimeInput(dailyTime);
      value = buildDailyCron(hour, minute);
    } else if (next === 'weekly') {
      const { hour, minute } = parseTimeInput(weeklyTime);
      value = buildWeeklyCron(weeklyDay, hour, minute);
    }
    // 'custom' intentionally leaves the raw value exactly as it is.
  }

  // While a structured preset is active, its own controls stay the source
  // of truth for `value` - editing the time or day rebuilds the expression.
  $effect(() => {
    if (preset !== 'daily') return;
    const { hour, minute } = parseTimeInput(dailyTime);
    value = buildDailyCron(hour, minute);
  });
  $effect(() => {
    if (preset !== 'weekly') return;
    const { hour, minute } = parseTimeInput(weeklyTime);
    value = buildWeeklyCron(weeklyDay, hour, minute);
  });

  const preview = $derived(value.trim() ? previewCron(value) : null);

  $effect(() => {
    valid = !value.trim() || (preview?.valid ?? false);
  });

  function formatRun(d: Date): string {
    return d.toLocaleString(undefined, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }
</script>

<div class="space-y-2">
  <div class="flex gap-1.5 flex-wrap">
    {#each PRESET_TABS as p (p.id)}
      <Button
        type="button"
        size="sm"
        variant={preset === p.id ? 'secondary' : 'ghost'}
        {disabled}
        onclick={() => selectPreset(p.id)}
      >
        {p.label}
      </Button>
    {/each}
  </div>

  {#if preset === 'daily'}
    <label class="flex items-center gap-2 text-xs">
      At
      <Input type="time" bind:value={dailyTime} {disabled} class="w-32" />
      <span class="text-muted-foreground">UTC</span>
    </label>
  {:else if preset === 'weekly'}
    <div class="flex items-center gap-2 text-xs flex-wrap">
      Every
      <SelectField
        value={weeklyDay}
        onValueChange={(v) => (weeklyDay = v as number)}
        options={WEEKDAY_OPTIONS}
        size="sm"
        {disabled}
      />
      at
      <Input type="time" bind:value={weeklyTime} {disabled} class="w-32" />
      <span class="text-muted-foreground">UTC</span>
    </div>
  {/if}

  <Input {id} bind:value placeholder="0 9 * * *" {disabled} class="font-mono" />

  {#if preview}
    {#if preview.valid}
      <div class="text-xs space-y-0.5">
        <p>{preview.description} (UTC)</p>
        <p class="text-muted-foreground">
          Next runs (your local time): {preview.nextRuns.map(formatRun).join(', ')}
        </p>
      </div>
    {:else}
      <p class="text-xs {TONE_TEXT_CLASS.rose}">{preview.error}</p>
    {/if}
  {:else}
    <p class="text-xs text-muted-foreground">
      No schedule set - the campaign only runs when triggered manually.
    </p>
  {/if}
</div>
