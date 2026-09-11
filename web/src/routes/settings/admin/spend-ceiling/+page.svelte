<script lang="ts">
  import * as Card from '$lib/components/ui/card';
  import * as Alert from '$lib/components/ui/alert';
  import { Info } from '@lucide/svelte';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import Seo from '$lib/components/Seo.svelte';
  import { toast } from 'svelte-sonner';
  import { invalidateAll } from '$app/navigation';
  import { untrack } from 'svelte';
  import { page } from '$app/stores';
  import { t, type Locale } from '$lib/i18n/index.js';

  const locale = $derived($page.data.locale as Locale);

  type PageData = {
    instanceMonthlyBudgetUsd: number | null;
    selfRegistrationMonthlyRunBudgetUsd: number;
    selfRegistrationMaxConcurrentRuns: number;
    monthToDateCostUsd: number;
    remainingUsd: number | null;
  };
  let { data }: { data: PageData } = $props();

  function money(n: number): string {
    return n.toLocaleString(undefined, { style: 'currency', currency: 'USD' });
  }

  // The instance ceiling is blank-for-unlimited, same convention as the
  // per-org budget field on settings/organization. The self-registration
  // defaults are never unlimited (createOrganization's no-invite path
  // always needs a real number to write onto the new org), so those two
  // fields stay plain numbers with no blank state.
  function toDraft(n: number | null): string {
    return n == null ? '' : String(n);
  }
  let instanceBudgetDraft = $state(
    untrack(() => toDraft(data.instanceMonthlyBudgetUsd)),
  );
  let selfRegBudgetDraft = $state(
    untrack(() => String(data.selfRegistrationMonthlyRunBudgetUsd)),
  );
  let selfRegConcurrencyDraft = $state(
    untrack(() => String(data.selfRegistrationMaxConcurrentRuns)),
  );
  let saving = $state(false);

  async function save() {
    if (saving) return;
    const instanceRaw = instanceBudgetDraft.trim();
    if (instanceRaw !== '' && Number(instanceRaw) < 0) {
      toast.error(t(locale, 'settings.admin.spend-ceiling.toast-error-negative'));
      return;
    }
    const selfRegBudget = Number(selfRegBudgetDraft.trim());
    if (!Number.isFinite(selfRegBudget) || selfRegBudget <= 0) {
      toast.error(t(locale, 'settings.admin.spend-ceiling.toast-error-budget'));
      return;
    }
    const selfRegConcurrency = Number(selfRegConcurrencyDraft.trim());
    if (!Number.isInteger(selfRegConcurrency) || selfRegConcurrency <= 0) {
      toast.error(t(locale, 'settings.admin.spend-ceiling.toast-error-concurrency'));
      return;
    }
    saving = true;
    try {
      const res = await fetch('/api/settings/admin/spend-ceiling', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          instanceMonthlyBudgetUsd: instanceRaw === '' ? null : Number(instanceRaw),
          selfRegistrationMonthlyRunBudgetUsd: selfRegBudget,
          selfRegistrationMaxConcurrentRuns: selfRegConcurrency,
        }),
      });
      if (!res.ok) {
        toast.error(
          res.status === 403
            ? t(locale, 'settings.admin.spend-ceiling.toast-error-forbidden')
            : t(locale, 'settings.admin.spend-ceiling.toast-error-save'),
        );
        return;
      }
      toast.success(t(locale, 'settings.admin.spend-ceiling.toast-success'));
      await invalidateAll();
    } catch {
      toast.error(t(locale, 'settings.admin.spend-ceiling.toast-error-save'));
    } finally {
      saving = false;
    }
  }
</script>

<Seo
  title={t(locale, 'settings.admin.spend-ceiling.seo-title')}
  description={t(locale, 'settings.admin.spend-ceiling.seo-description')}
/>

<PageHeader
  title={t(locale, 'settings.admin.spend-ceiling.title')}
  description={t(locale, 'settings.admin.spend-ceiling.description')}
/>

<div class="flex flex-col gap-6">
  <Alert.Root>
    <Info class="size-4" />
    <Alert.Description>
      {t(locale, 'settings.admin.spend-ceiling.info')}
    </Alert.Description>
  </Alert.Root>

  <Card.Root class="max-w-2xl">
    <Card.Header>
      <Card.Title class="text-base">{t(locale, 'settings.admin.spend-ceiling.instance-card-title')}</Card.Title>
      <p class="text-sm text-muted-foreground">
        {t(locale, 'settings.admin.spend-ceiling.instance-card-description')}
      </p>
    </Card.Header>
    <Card.Content class="flex flex-col gap-4">
      <div class="grid gap-4 sm:grid-cols-2">
        <div class="flex flex-col gap-1.5">
          <label class="text-sm font-medium" for="instance-budget"
            >{t(locale, 'settings.admin.spend-ceiling.instance-budget-label')}</label
          >
          <Input
            id="instance-budget"
            type="number"
            min="0"
            step="0.01"
            placeholder={t(locale, 'settings.admin.spend-ceiling.instance-budget-placeholder')}
            bind:value={instanceBudgetDraft}
          />
        </div>
      </div>
      <div class="grid gap-4 sm:grid-cols-2">
        <div class="flex flex-col gap-1">
          <span class="text-sm font-medium">{t(locale, 'settings.admin.spend-ceiling.month-to-date-label')}</span>
          <span class="text-sm text-muted-foreground">{money(data.monthToDateCostUsd)}</span>
        </div>
        <div class="flex flex-col gap-1">
          <span class="text-sm font-medium">{t(locale, 'settings.admin.spend-ceiling.remaining-label')}</span>
          <span class="text-sm text-muted-foreground">
            {data.remainingUsd == null
              ? t(locale, 'settings.admin.spend-ceiling.unlimited')
              : money(data.remainingUsd)}
          </span>
        </div>
      </div>
    </Card.Content>
  </Card.Root>

  <Card.Root class="max-w-2xl">
    <Card.Header>
      <Card.Title class="text-base">{t(locale, 'settings.admin.spend-ceiling.self-reg-card-title')}</Card.Title>
      <p class="text-sm text-muted-foreground">
        {t(locale, 'settings.admin.spend-ceiling.self-reg-card-description')}
      </p>
    </Card.Header>
    <Card.Content class="flex flex-col gap-4">
      <div class="grid gap-4 sm:grid-cols-2">
        <div class="flex flex-col gap-1.5">
          <label class="text-sm font-medium" for="self-reg-budget"
            >{t(locale, 'settings.admin.spend-ceiling.self-reg-budget-label')}</label
          >
          <Input
            id="self-reg-budget"
            type="number"
            min="0.01"
            step="0.01"
            bind:value={selfRegBudgetDraft}
          />
        </div>
        <div class="flex flex-col gap-1.5">
          <label class="text-sm font-medium" for="self-reg-concurrency"
            >{t(locale, 'settings.admin.spend-ceiling.self-reg-concurrency-label')}</label
          >
          <Input
            id="self-reg-concurrency"
            type="number"
            min="1"
            step="1"
            bind:value={selfRegConcurrencyDraft}
          />
        </div>
      </div>
    </Card.Content>
  </Card.Root>

  <div>
    <Button onclick={save} loading={saving}>{t(locale, 'settings.admin.spend-ceiling.save')}</Button>
  </div>
</div>
