<script lang="ts">
  import * as Card from '$lib/components/ui/card';
  import * as Alert from '$lib/components/ui/alert';
  import * as Table from '$lib/components/ui/table';
  import * as AlertDialog from '$lib/components/ui/alert-dialog';
  import { Badge } from '$lib/components/ui/badge';
  import { Button } from '$lib/components/ui/button';
  import { Textarea } from '$lib/components/ui/textarea';
  import { SelectField } from '$lib/components/ui/select-field';
  import { Info } from '@lucide/svelte';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import PageContainer from '$lib/components/PageContainer.svelte';
  import Seo from '$lib/components/Seo.svelte';
  import { toast } from 'svelte-sonner';
  import { invalidateAll } from '$app/navigation';
  import { page } from '$app/stores';
  import { t, type Locale } from '$lib/i18n/index.js';

  const locale = $derived($page.data.locale as Locale);

  type PlanId = 'free' | 'solo' | 'growth' | 'scale';
  type OrgPlanRow = {
    id: number;
    slug: string;
    name: string;
    plan: PlanId;
    planSource: string;
    stripeCustomerId: string | null;
    mirroredSubscriptionPlanId: PlanId | null;
  };
  type PageData = { orgs: OrgPlanRow[]; plans: { id: PlanId; name: string }[] };
  let { data }: { data: PageData } = $props();

  const planLabel = (id: PlanId) => data.plans.find((p) => p.id === id)?.name ?? id;
  const orgOptions = $derived(
    data.orgs.map((o) => ({ value: o.id, label: `${o.name} (${o.slug})` })),
  );
  const planOptions = $derived(data.plans.map((p) => ({ value: p.id, label: p.name })));

  let grantOrgId = $state<number | undefined>(undefined);
  let grantPlanId = $state<PlanId>('free');
  let grantReason = $state('');
  let granting = $state(false);

  async function grant() {
    if (!grantOrgId || !grantReason.trim()) return;
    granting = true;
    try {
      const res = await fetch('/api/settings/admin/org-plans', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ orgId: grantOrgId, planId: grantPlanId, reason: grantReason.trim() }),
      });
      if (!res.ok) {
        toast.error(t(locale, 'settings.admin.plan-grants.toast-grant-error'));
        return;
      }
      toast.success(
        t(locale, 'settings.admin.plan-grants.toast-grant-success', { plan: planLabel(grantPlanId) }),
      );
      grantReason = '';
      await invalidateAll();
    } catch {
      toast.error(t(locale, 'settings.admin.plan-grants.toast-grant-error'));
    } finally {
      granting = false;
    }
  }

  let revokeTarget = $state<OrgPlanRow | null>(null);
  let revoking = $state(false);

  async function confirmRevoke() {
    if (!revokeTarget) return;
    revoking = true;
    try {
      const res = await fetch('/api/settings/admin/org-plans', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ orgId: revokeTarget.id }),
      });
      if (!res.ok) {
        toast.error(t(locale, 'settings.admin.plan-grants.toast-revoke-error'));
        return;
      }
      toast.success(t(locale, 'settings.admin.plan-grants.toast-revoke-success'));
      revokeTarget = null;
      await invalidateAll();
    } catch {
      toast.error(t(locale, 'settings.admin.plan-grants.toast-revoke-error'));
    } finally {
      revoking = false;
    }
  }
</script>

<Seo
  title={t(locale, 'settings.admin.plan-grants.seo-title')}
  description={t(locale, 'settings.admin.plan-grants.seo-description')}
/>

<PageContainer size="default">
  <PageHeader
    title={t(locale, 'settings.admin.plan-grants.title')}
    description={t(locale, 'settings.admin.plan-grants.description')}
  />

  <Alert.Root class="mb-6">
    <Info class="size-4" />
    <Alert.Description>
      {t(locale, 'settings.admin.plan-grants.info')}
    </Alert.Description>
  </Alert.Root>

  <Card.Root class="mt-2 max-w-3xl">
    <Card.Header>
      <Card.Title>{t(locale, 'settings.admin.plan-grants.grant-card-title')}</Card.Title>
      <Card.Description>
        {t(locale, 'settings.admin.plan-grants.grant-card-description')}
      </Card.Description>
    </Card.Header>
    <Card.Content class="flex flex-col gap-3 sm:max-w-md">
      <SelectField
        value={grantOrgId}
        options={orgOptions}
        placeholder={t(locale, 'settings.admin.plan-grants.org-placeholder')}
        onValueChange={(v) => (grantOrgId = v)}
      />
      <SelectField
        value={grantPlanId}
        options={planOptions}
        placeholder={t(locale, 'settings.admin.plan-grants.plan-placeholder')}
        onValueChange={(v) => (grantPlanId = v)}
      />
      <Textarea
        bind:value={grantReason}
        placeholder={t(locale, 'settings.admin.plan-grants.reason-placeholder')}
        rows={2}
      />
      <div>
        <Button
          disabled={!grantOrgId || !grantReason.trim()}
          loading={granting}
          onclick={grant}
        >
          {t(locale, 'settings.admin.plan-grants.grant-button')}
        </Button>
      </div>
    </Card.Content>
  </Card.Root>

  <Card.Root class="mt-8 max-w-4xl">
    <Card.Header>
      <Card.Title>{t(locale, 'settings.admin.plan-grants.orgs-card-title')}</Card.Title>
      <Card.Description>
        {t(locale, 'settings.admin.plan-grants.orgs-card-description')}
      </Card.Description>
    </Card.Header>
    <Card.Content>
      <Table.Root>
        <Table.Header>
          <Table.Row>
            <Table.Head>{t(locale, 'settings.admin.plan-grants.column-organization')}</Table.Head>
            <Table.Head>{t(locale, 'settings.admin.plan-grants.column-plan')}</Table.Head>
            <Table.Head>{t(locale, 'settings.admin.plan-grants.column-source')}</Table.Head>
            <Table.Head>{t(locale, 'settings.admin.plan-grants.column-stripe-customer')}</Table.Head>
            <Table.Head class="text-right">{t(locale, 'settings.admin.plan-grants.column-action')}</Table.Head>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {#each data.orgs as org (org.id)}
            <Table.Row>
              <Table.Cell class="font-medium">{org.name} <span class="text-muted-foreground">({org.slug})</span></Table.Cell>
              <Table.Cell>{planLabel(org.plan)}</Table.Cell>
              <Table.Cell>
                {#if org.planSource === 'grant'}
                  <Badge variant="default">{t(locale, 'settings.admin.plan-grants.source-grant')}</Badge>
                {:else if org.planSource === 'stripe'}
                  <Badge variant="outline">{t(locale, 'settings.admin.plan-grants.source-stripe')}</Badge>
                {:else}
                  <Badge variant="outline" class="text-muted-foreground"
                    >{t(locale, 'settings.admin.plan-grants.source-default')}</Badge
                  >
                {/if}
              </Table.Cell>
              <Table.Cell>
                {#if org.stripeCustomerId}
                  <Badge variant="outline">{t(locale, 'settings.admin.plan-grants.stripe-yes')}</Badge>
                {:else}
                  <span class="text-muted-foreground">{t(locale, 'settings.admin.plan-grants.stripe-none')}</span>
                {/if}
              </Table.Cell>
              <Table.Cell class="text-right">
                {#if org.planSource === 'grant'}
                  <Button variant="outline" size="sm" onclick={() => (revokeTarget = org)}>
                    {t(locale, 'settings.admin.plan-grants.revoke-button')}
                  </Button>
                {/if}
              </Table.Cell>
            </Table.Row>
          {/each}
        </Table.Body>
      </Table.Root>
    </Card.Content>
  </Card.Root>
</PageContainer>

<AlertDialog.Root open={revokeTarget !== null} onOpenChange={(v) => !v && (revokeTarget = null)}>
  <AlertDialog.Content>
    <AlertDialog.Header>
      <AlertDialog.Title>
        {t(locale, 'settings.admin.plan-grants.confirm-title', {
          org: revokeTarget?.name ?? t(locale, 'settings.admin.plan-grants.confirm-fallback-org'),
        })}
      </AlertDialog.Title>
      <AlertDialog.Description>
        {#if revokeTarget}
          {@const landing = revokeTarget.mirroredSubscriptionPlanId
            ? t(locale, 'settings.admin.plan-grants.confirm-landing-mirrored', {
                plan: planLabel(revokeTarget.mirroredSubscriptionPlanId),
              })
            : t(locale, 'settings.admin.plan-grants.confirm-landing-no-mirror')}
          {t(locale, 'settings.admin.plan-grants.confirm-body', { landing })}
        {/if}
      </AlertDialog.Description>
    </AlertDialog.Header>
    <AlertDialog.Footer>
      <AlertDialog.Cancel onclick={() => (revokeTarget = null)}>
        {t(locale, 'settings.admin.plan-grants.cancel')}
      </AlertDialog.Cancel>
      <AlertDialog.Action onclick={confirmRevoke} disabled={revoking}>
        {revoking
          ? t(locale, 'settings.admin.plan-grants.revoking')
          : t(locale, 'settings.admin.plan-grants.revoke-button')}
      </AlertDialog.Action>
    </AlertDialog.Footer>
  </AlertDialog.Content>
</AlertDialog.Root>
