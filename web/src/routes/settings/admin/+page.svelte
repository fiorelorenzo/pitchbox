<script lang="ts">
  import * as Card from '$lib/components/ui/card';
  import * as Alert from '$lib/components/ui/alert';
  import * as Table from '$lib/components/ui/table';
  import { Badge } from '$lib/components/ui/badge';
  import { Button } from '$lib/components/ui/button';
  import { Info, Bot, Gauge, Archive, Webhook } from '@lucide/svelte';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import PageContainer from '$lib/components/PageContainer.svelte';
  import Seo from '$lib/components/Seo.svelte';
  import { toast } from 'svelte-sonner';
  import { invalidateAll } from '$app/navigation';

  type AdminUser = { id: number; username: string; isInstanceAdmin: boolean };
  type PageData = { authOn: boolean; users: AdminUser[] };
  let { data }: { data: PageData } = $props();

  let promoting = $state<number | null>(null);

  async function promote(userId: number) {
    promoting = userId;
    try {
      const res = await fetch('/api/settings/admin/promote', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId }),
      });
      if (!res.ok) {
        toast.error('Could not promote that user');
        return;
      }
      toast.success('Promoted to instance admin');
      await invalidateAll();
    } catch {
      toast.error('Could not promote that user');
    } finally {
      promoting = null;
    }
  }

  const links = [
    {
      href: '/settings/runners',
      icon: Bot,
      label: 'Agent runners',
      description: 'Default runner and per-runner config for every organization.',
    },
    {
      href: '/settings/quota',
      icon: Gauge,
      label: 'Quota',
      description: 'Per-platform posting quota defaults shared by every organization.',
    },
    {
      href: '/settings/retention',
      icon: Archive,
      label: 'Retention',
      description: 'How long drafts, run events and webhook deliveries are kept.',
    },
    {
      href: '/notifications',
      icon: Webhook,
      label: 'Outgoing webhook',
      description: 'The dashboard-wide notification webhook URL and its delivery log.',
    },
  ];
</script>

<Seo title="Settings - Instance admin" description="Instance-wide configuration for the operator of this deployment." />

<PageContainer size="default">
  <PageHeader
    title="Instance admin"
    description="Configuration that belongs to the operator of this deployment, not to any one organization."
  />

  {#if !data.authOn}
    <Alert.Root class="mb-6">
      <Info class="size-4" />
      <Alert.Title>PITCHBOX_AUTH is off</Alert.Title>
      <Alert.Description>
        This instance has no sign-in, so there is only one operator and this area is always
        reachable - the same reason organization settings disappear from the rail.
      </Alert.Description>
    </Alert.Root>
  {/if}

  <p class="mb-6 max-w-2xl text-sm text-muted-foreground">
    A few settings are instance-wide rather than per-organization: any user can create their own
    organization and become its admin, but that must never grant them the config below, which
    every organization on this deployment shares. Those pages already existed before this area
    did and keep their own write gate; this is a landing spot that points at them rather than a
    second copy of them.
  </p>

  <div class="grid max-w-3xl grid-cols-1 gap-4 sm:grid-cols-2">
    {#each links as link (link.href)}
      {@const Icon = link.icon}
      <a href={link.href} class="block">
        <Card.Root size="sm" class="h-full transition-colors hover:bg-accent/50">
          <Card.Header class="flex flex-row flex-nowrap items-center gap-2 space-y-0">
            <Icon class="size-4 shrink-0 text-muted-foreground" />
            <Card.Title class="text-base min-w-0 flex-1 truncate">{link.label}</Card.Title>
          </Card.Header>
          <Card.Content>
            <p class="text-xs text-muted-foreground">{link.description}</p>
          </Card.Content>
        </Card.Root>
      </a>
    {/each}
  </div>

  <Card.Root class="mt-8 max-w-3xl">
    <Card.Header>
      <Card.Title>Instance admins</Card.Title>
      <Card.Description>
        Every user on this deployment and whether they hold the instance-admin flag. Promoting a
        user here is the supported way to grant it once the deployment's first account has
        already claimed it (#413) - the only other way is `seed:owner` before anyone signs up.
      </Card.Description>
    </Card.Header>
    <Card.Content>
      <Table.Root>
        <Table.Header>
          <Table.Row>
            <Table.Head>User</Table.Head>
            <Table.Head>Instance admin</Table.Head>
            <Table.Head class="text-right">Action</Table.Head>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {#each data.users as u (u.id)}
            <Table.Row>
              <Table.Cell class="font-medium">{u.username}</Table.Cell>
              <Table.Cell>
                {#if u.isInstanceAdmin}
                  <Badge variant="default">Instance admin</Badge>
                {:else}
                  <Badge variant="outline" class="text-muted-foreground">Member</Badge>
                {/if}
              </Table.Cell>
              <Table.Cell class="text-right">
                {#if !u.isInstanceAdmin}
                  <Button
                    variant="outline"
                    size="sm"
                    onclick={() => promote(u.id)}
                    loading={promoting === u.id}
                  >
                    Promote
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
