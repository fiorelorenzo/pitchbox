<script lang="ts">
  import * as Card from '$lib/components/ui/card';
  import * as Alert from '$lib/components/ui/alert';
  import * as Table from '$lib/components/ui/table';
  import { Badge } from '$lib/components/ui/badge';
  import { Button } from '$lib/components/ui/button';
  import { SelectField } from '$lib/components/ui/select-field';
  import { Info } from '@lucide/svelte';
  import { page } from '$app/stores';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import Seo from '$lib/components/Seo.svelte';
  import { toast } from 'svelte-sonner';
  import { invalidateAll } from '$app/navigation';
  import { adminLinks } from './admin-links.js';
  import { t, type Locale } from '$lib/i18n/index.js';

  const locale = $derived($page.data.locale as Locale);
  const links = $derived(adminLinks(locale));

  type AdminUser = { id: number; username: string; isInstanceAdmin: boolean };
  type RegistrationPolicy = 'open' | 'invite' | 'off';
  type PageData = { authOn: boolean; users: AdminUser[]; registrationPolicy: RegistrationPolicy };
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
        toast.error(t(locale, 'settings.admin.error-promote-failed'));
        return;
      }
      toast.success(t(locale, 'settings.admin.promoted'));
      await invalidateAll();
    } catch {
      toast.error(t(locale, 'settings.admin.error-promote-failed'));
    } finally {
      promoting = null;
    }
  }

  const REGISTRATION_POLICY_OPTIONS = $derived<{ value: RegistrationPolicy; label: string }[]>([
    { value: 'open', label: t(locale, 'settings.admin.registration.option-open') },
    { value: 'invite', label: t(locale, 'settings.admin.registration.option-invite') },
    { value: 'off', label: t(locale, 'settings.admin.registration.option-off') },
  ]);
  // svelte-ignore state_referenced_locally
  let registrationPolicy = $state<RegistrationPolicy>(data.registrationPolicy);
  let savingRegistrationPolicy = $state(false);

  async function saveRegistrationPolicy(next: RegistrationPolicy) {
    const previous = registrationPolicy;
    registrationPolicy = next;
    savingRegistrationPolicy = true;
    try {
      const res = await fetch('/api/settings/admin/registration', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ policy: next }),
      });
      if (!res.ok) {
        registrationPolicy = previous;
        toast.error(t(locale, 'settings.admin.registration.error-save-failed'));
        return;
      }
      toast.success(t(locale, 'settings.admin.registration.success-saved'));
    } catch {
      registrationPolicy = previous;
      toast.error(t(locale, 'settings.admin.registration.error-save-failed'));
    } finally {
      savingRegistrationPolicy = false;
    }
  }
</script>

<Seo
  title={t(locale, 'settings.admin.seo-title')}
  description={t(locale, 'settings.admin.seo-description')}
/>

<PageHeader
  title={t(locale, 'settings.admin.title')}
  description={t(locale, 'settings.admin.description')}
/>

<div class="flex flex-col gap-6">
  {#if !data.authOn}
    <Alert.Root>
      <Info class="size-4" />
      <Alert.Title>{t(locale, 'settings.admin.auth-off-title')}</Alert.Title>
      <Alert.Description>
        {t(locale, 'settings.admin.auth-off-description')}
      </Alert.Description>
    </Alert.Root>
  {/if}

  <p class="max-w-2xl text-sm text-muted-foreground">
    {t(locale, 'settings.admin.intro')}
  </p>

  <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
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

  <Card.Root class="max-w-3xl">
    <Card.Header>
      <Card.Title>{t(locale, 'settings.admin.registration.title')}</Card.Title>
      <Card.Description>
        {t(locale, 'settings.admin.registration.description')}
      </Card.Description>
    </Card.Header>
    <Card.Content class="flex flex-col gap-2 sm:max-w-sm">
      <SelectField
        value={registrationPolicy}
        onValueChange={(v) => saveRegistrationPolicy(v as RegistrationPolicy)}
        options={REGISTRATION_POLICY_OPTIONS}
        disabled={savingRegistrationPolicy}
        fullWidth
      />
    </Card.Content>
  </Card.Root>

  <Card.Root class="max-w-3xl">
    <Card.Header>
      <Card.Title>{t(locale, 'settings.admin.instance-admins.title')}</Card.Title>
      <Card.Description>
        {t(locale, 'settings.admin.instance-admins.description')}
      </Card.Description>
    </Card.Header>
    <Card.Content>
      <Table.Root>
        <Table.Header>
          <Table.Row>
            <Table.Head>{t(locale, 'settings.admin.instance-admins.column-user')}</Table.Head>
            <Table.Head>{t(locale, 'settings.admin.instance-admins.column-instance-admin')}</Table.Head>
            <Table.Head class="text-right">{t(locale, 'settings.admin.instance-admins.column-action')}</Table.Head>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {#each data.users as u (u.id)}
            <Table.Row>
              <Table.Cell class="font-medium">{u.username}</Table.Cell>
              <Table.Cell>
                {#if u.isInstanceAdmin}
                  <Badge variant="default">{t(locale, 'settings.admin.instance-admins.badge-admin')}</Badge>
                {:else}
                  <Badge variant="outline" class="text-muted-foreground"
                    >{t(locale, 'settings.admin.instance-admins.badge-member')}</Badge
                  >
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
                    {t(locale, 'settings.admin.instance-admins.promote')}
                  </Button>
                {/if}
              </Table.Cell>
            </Table.Row>
          {/each}
        </Table.Body>
      </Table.Root>
    </Card.Content>
  </Card.Root>
</div>
