<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/stores';
  import { t, type Locale } from '$lib/i18n/index.js';
  import Spinner from '$lib/components/Spinner.svelte';
  import PageContainer from '$lib/components/PageContainer.svelte';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import { SelectField } from '$lib/components/ui/select-field';
  import { TONE_BANNER_CLASS } from '$lib/config/status-badges';

  type Stage = { stage: string; count: number; rate: number | null };
  type Range = '7d' | '30d' | 'all';

  let { data } = $props<{ data: { campaigns: { id: number; name: string }[] } }>();
  const locale = $derived($page.data.locale as Locale);

  function parseRange(value: string | null): Range {
    return value === '7d' || value === '30d' ? value : 'all';
  }

  // Seeded from the URL so a shared link or a reload lands on the same filters.
  let campaignId = $state<string>($page.url.searchParams.get('campaign_id') ?? '');
  let range = $state<Range>(parseRange($page.url.searchParams.get('range')));
  let stages = $state<Stage[]>([]);
  let loading = $state(false);
  let error = $state<string | null>(null);

  const campaignOptions = $derived([
    { value: '', label: t(locale, 'analytics.all-campaigns') },
    ...data.campaigns.map((c: { id: number; name: string }) => ({
      value: String(c.id),
      label: c.name,
    })),
  ]);

  const RANGE_OPTIONS: { value: Range; label: string }[] = $derived([
    { value: '7d', label: t(locale, 'analytics.range.7d') },
    { value: '30d', label: t(locale, 'analytics.range.30d') },
    { value: 'all', label: t(locale, 'analytics.range.all') },
  ]);

  // Built from scratch rather than off `$page.url` so this never subscribes to
  // the page store from inside the effect below - doing that would make every
  // `goto` call re-trigger the same effect that issued it.
  function syncUrl() {
    const params = new URLSearchParams();
    if (campaignId) params.set('campaign_id', campaignId);
    if (range !== 'all') params.set('range', range);
    const qs = params.toString();
    goto(qs ? `/analytics?${qs}` : '/analytics', {
      replaceState: true,
      noScroll: true,
      keepFocus: true,
    });
  }

  async function load() {
    loading = true;
    error = null;
    try {
      const url = new URL('/api/analytics/funnel', window.location.origin);
      if (campaignId) url.searchParams.set('campaign_id', campaignId);
      if (range !== 'all') url.searchParams.set('range', range);
      const res = await fetch(url.toString());
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (res.status >= 500) {
          console.error('failed to load analytics funnel', res.status, body);
          error = t(locale, 'analytics.error-5xx');
        } else {
          error = body.error ?? t(locale, 'analytics.error-http', { status: res.status });
        }
        stages = [];
        return;
      }
      stages = (body.stages ?? []) as Stage[];
    } catch {
      error = t(locale, 'analytics.error-network');
      stages = [];
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    // Runs once on mount and again whenever either filter changes.
    void campaignId;
    void range;
    syncUrl();
    load();
  });

  const max = $derived(stages.length > 0 ? Math.max(...stages.map((s) => s.count), 1) : 1);
</script>

<PageContainer size="default">
  <PageHeader
    title={t(locale, 'analytics.title')}
    description={t(locale, 'analytics.header-description')}
  />

  <div class="mb-6 flex flex-wrap items-end gap-3">
    <div class="flex flex-col gap-1">
      <label class="text-xs text-muted-foreground" for="analytics-campaign">{t(locale, 'analytics.label-campaign')}</label>
      <SelectField id="analytics-campaign" bind:value={campaignId} options={campaignOptions} />
    </div>
    <div class="flex flex-col gap-1">
      <label class="text-xs text-muted-foreground" for="analytics-range">{t(locale, 'analytics.label-range')}</label>
      <SelectField id="analytics-range" bind:value={range} options={RANGE_OPTIONS} />
    </div>
  </div>

  {#if loading}
    <div class="flex items-center gap-2 text-sm text-muted-foreground">
      <Spinner size="sm" />
      <span>{t(locale, 'analytics.loading')}</span>
    </div>
  {:else if error}
    <div role="alert" class="rounded-md border p-4 text-sm {TONE_BANNER_CLASS.rose}">
      {error}
    </div>
  {:else if stages.length === 0}
    <p class="text-sm text-muted-foreground">{t(locale, 'analytics.no-data')}</p>
  {:else}
    <div class="flex flex-col gap-3">
      {#each stages as s (s.stage)}
        {@const width = Math.max(2, Math.round((s.count / max) * 100))}
        <div>
          <div class="flex items-baseline justify-between text-sm mb-1">
            <span class="font-medium capitalize">{t(locale, `analytics.stage.${s.stage}`)}</span>
            <span class="text-muted-foreground">
              {s.count}
              {#if s.rate !== null}
                <span class="ml-2 font-mono text-xs">{s.rate}%</span>
              {/if}
            </span>
          </div>
          <div class="h-6 bg-muted rounded-md overflow-hidden">
            <div class="h-full bg-sky-500/70" style="width: {width}%"></div>
          </div>
        </div>
      {/each}
    </div>
  {/if}
</PageContainer>
