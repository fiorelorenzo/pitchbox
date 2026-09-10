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
        toast.error('Could not grant that plan');
        return;
      }
      toast.success(`${planLabel(grantPlanId)} granted`);
      grantReason = '';
      await invalidateAll();
    } catch {
      toast.error('Could not grant that plan');
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
        toast.error('Could not revoke that grant');
        return;
      }
      toast.success('Grant revoked');
      revokeTarget = null;
      await invalidateAll();
    } catch {
      toast.error('Could not revoke that grant');
    } finally {
      revoking = false;
    }
  }
</script>

<Seo
  title="Settings - Plan grants"
  description="Grant or revoke a plan on any organization, bypassing Stripe."
/>

<PageContainer size="default">
  <PageHeader
    title="Plan grants"
    description="Set or revoke a plan on any organization directly - the self-host fallback and every hand-granted org (mine included) got here without ever touching Stripe."
  />

  <Alert.Root class="mb-6">
    <Info class="size-4" />
    <Alert.Description>
      A grant outranks a live Stripe subscription for that org: checkout, the portal and webhook
      updates all leave a grant alone until it is revoked here. Revoking never guesses - it lands
      on the plan a mirrored Stripe subscription names, or Free if there is none.
    </Alert.Description>
  </Alert.Root>

  <Card.Root class="mt-2 max-w-3xl">
    <Card.Header>
      <Card.Title>Grant a plan</Card.Title>
      <Card.Description>
        Written through the same `setOrgPlan` the Stripe webhook itself calls, recorded in the
        instance audit log with the reason below.
      </Card.Description>
    </Card.Header>
    <Card.Content class="flex flex-col gap-3 sm:max-w-md">
      <SelectField
        value={grantOrgId}
        options={orgOptions}
        placeholder="Pick an organization"
        onValueChange={(v) => (grantOrgId = v)}
      />
      <SelectField
        value={grantPlanId}
        options={planOptions}
        placeholder="Pick a plan"
        onValueChange={(v) => (grantPlanId = v)}
      />
      <Textarea
        bind:value={grantReason}
        placeholder="Why this org is on a grant (kept in the audit log, not shown to the org)"
        rows={2}
      />
      <div>
        <Button
          disabled={!grantOrgId || !grantReason.trim()}
          loading={granting}
          onclick={grant}
        >
          Grant
        </Button>
      </div>
    </Card.Content>
  </Card.Root>

  <Card.Root class="mt-8 max-w-4xl">
    <Card.Header>
      <Card.Title>Organizations</Card.Title>
      <Card.Description>
        Every organization on this deployment, its plan, and where that plan came from.
      </Card.Description>
    </Card.Header>
    <Card.Content>
      <Table.Root>
        <Table.Header>
          <Table.Row>
            <Table.Head>Organization</Table.Head>
            <Table.Head>Plan</Table.Head>
            <Table.Head>Source</Table.Head>
            <Table.Head>Stripe customer</Table.Head>
            <Table.Head class="text-right">Action</Table.Head>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {#each data.orgs as org (org.id)}
            <Table.Row>
              <Table.Cell class="font-medium">{org.name} <span class="text-muted-foreground">({org.slug})</span></Table.Cell>
              <Table.Cell>{planLabel(org.plan)}</Table.Cell>
              <Table.Cell>
                {#if org.planSource === 'grant'}
                  <Badge variant="default">Grant</Badge>
                {:else if org.planSource === 'stripe'}
                  <Badge variant="outline">Stripe</Badge>
                {:else}
                  <Badge variant="outline" class="text-muted-foreground">Default</Badge>
                {/if}
              </Table.Cell>
              <Table.Cell>
                {#if org.stripeCustomerId}
                  <Badge variant="outline">Yes</Badge>
                {:else}
                  <span class="text-muted-foreground">None</span>
                {/if}
              </Table.Cell>
              <Table.Cell class="text-right">
                {#if org.planSource === 'grant'}
                  <Button variant="outline" size="sm" onclick={() => (revokeTarget = org)}>
                    Revoke
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
      <AlertDialog.Title>Revoke the grant on {revokeTarget?.name ?? 'this organization'}?</AlertDialog.Title>
      <AlertDialog.Description>
        {#if revokeTarget}
          This lands the org on
          {revokeTarget.mirroredSubscriptionPlanId
            ? `${planLabel(revokeTarget.mirroredSubscriptionPlanId)}, the plan its mirrored Stripe subscription names`
            : 'Free, since it has no mirrored Stripe subscription'}. Checkout, the portal and the
          billing page all become reachable again for this org.
        {/if}
      </AlertDialog.Description>
    </AlertDialog.Header>
    <AlertDialog.Footer>
      <AlertDialog.Cancel onclick={() => (revokeTarget = null)}>Cancel</AlertDialog.Cancel>
      <AlertDialog.Action onclick={confirmRevoke} disabled={revoking}>
        {revoking ? 'Revoking…' : 'Revoke'}
      </AlertDialog.Action>
    </AlertDialog.Footer>
  </AlertDialog.Content>
</AlertDialog.Root>
