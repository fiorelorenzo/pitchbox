<script lang="ts">
  import * as Card from '$lib/components/ui/card';
  import * as Alert from '$lib/components/ui/alert';
  import { Info } from '@lucide/svelte';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import PageContainer from '$lib/components/PageContainer.svelte';
  import Seo from '$lib/components/Seo.svelte';
  import { toast } from 'svelte-sonner';
  import { invalidateAll } from '$app/navigation';
  import { untrack } from 'svelte';

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
      toast.error('Instance ceiling cannot be negative');
      return;
    }
    const selfRegBudget = Number(selfRegBudgetDraft.trim());
    if (!Number.isFinite(selfRegBudget) || selfRegBudget <= 0) {
      toast.error('Self-registration budget must be a positive number');
      return;
    }
    const selfRegConcurrency = Number(selfRegConcurrencyDraft.trim());
    if (!Number.isInteger(selfRegConcurrency) || selfRegConcurrency <= 0) {
      toast.error('Self-registration concurrency must be a positive whole number');
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
        toast.error(res.status === 403 ? 'You need instance-admin access for that' : 'Could not save');
        return;
      }
      toast.success('Spend ceiling saved');
      await invalidateAll();
    } catch {
      toast.error('Could not save');
    } finally {
      saving = false;
    }
  }
</script>

<Seo
  title="Settings - Spend ceiling"
  description="The instance-wide Gateway ceiling and what a self-registered organization starts with."
/>

<PageContainer size="default">
  <PageHeader
    title="Spend ceiling"
    description="Opening registration to strangers turns a per-organization cap into an unbounded instance-wide one. These two numbers are the backstop: an instance-wide monthly ceiling summed across every organization, and the caps a self-registered organization starts with, separate from what an invited or manually-provisioned organization gets."
  />

  <Alert.Root class="mb-6">
    <Info class="size-4" />
    <Alert.Description>
      A run refused by the instance ceiling fails with its own reason, distinct from an
      organization's own budget, so it's clear on which side of the line the money ran out.
    </Alert.Description>
  </Alert.Root>

  <Card.Root class="max-w-2xl">
    <Card.Header>
      <Card.Title class="text-base">Instance-wide monthly ceiling</Card.Title>
      <p class="text-sm text-muted-foreground">
        Summed month-to-date Gateway spend across every organization on this deployment. Leave
        blank for unlimited.
      </p>
    </Card.Header>
    <Card.Content class="flex flex-col gap-4">
      <div class="grid gap-4 sm:grid-cols-2">
        <div class="flex flex-col gap-1.5">
          <label class="text-sm font-medium" for="instance-budget">Monthly ceiling (USD)</label>
          <Input
            id="instance-budget"
            type="number"
            min="0"
            step="0.01"
            placeholder="Unlimited"
            bind:value={instanceBudgetDraft}
          />
        </div>
      </div>
      <div class="grid gap-4 sm:grid-cols-2">
        <div class="flex flex-col gap-1">
          <span class="text-sm font-medium">Month-to-date spend</span>
          <span class="text-sm text-muted-foreground">{money(data.monthToDateCostUsd)}</span>
        </div>
        <div class="flex flex-col gap-1">
          <span class="text-sm font-medium">Remaining</span>
          <span class="text-sm text-muted-foreground">
            {data.remainingUsd == null ? 'Unlimited' : money(data.remainingUsd)}
          </span>
        </div>
      </div>
    </Card.Content>
  </Card.Root>

  <Card.Root class="mt-6 max-w-2xl">
    <Card.Header>
      <Card.Title class="text-base">Self-registration defaults</Card.Title>
      <p class="text-sm text-muted-foreground">
        What a stranger who signs up with no invite starts with (`/register`'s no-invite path).
        Separate from the invited-organization defaults on purpose: raising what a paying or
        invited tenant gets never raises what a stranger gets.
      </p>
    </Card.Header>
    <Card.Content class="flex flex-col gap-4">
      <div class="grid gap-4 sm:grid-cols-2">
        <div class="flex flex-col gap-1.5">
          <label class="text-sm font-medium" for="self-reg-budget">Monthly run budget (USD)</label>
          <Input
            id="self-reg-budget"
            type="number"
            min="0.01"
            step="0.01"
            bind:value={selfRegBudgetDraft}
          />
        </div>
        <div class="flex flex-col gap-1.5">
          <label class="text-sm font-medium" for="self-reg-concurrency">Max concurrent runs</label>
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

  <div class="mt-6">
    <Button onclick={save} loading={saving}>Save</Button>
  </div>
</PageContainer>
