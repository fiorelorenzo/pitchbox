<script lang="ts">
  import * as Card from '$lib/components/ui/card';
  import * as Alert from '$lib/components/ui/alert';
  import { Info, Bot, Gauge, Archive, Webhook } from '@lucide/svelte';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import PageContainer from '$lib/components/PageContainer.svelte';
  import Seo from '$lib/components/Seo.svelte';

  type PageData = { authOn: boolean };
  let { data }: { data: PageData } = $props();

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
</PageContainer>
