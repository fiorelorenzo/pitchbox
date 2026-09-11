<script lang="ts">
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
  import * as Dialog from '$lib/components/ui/dialog';
  import * as Avatar from '$lib/components/ui/avatar';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { Check, ChevronsUpDown, Plus, Users } from '@lucide/svelte';
  import { page } from '$app/stores';
  import { goto, invalidateAll } from '$app/navigation';
  import { toast } from 'svelte-sonner';
  import { t, type Locale } from '$lib/i18n/index.js';

  type OrgSummary = { id: number; slug: string; name: string; role: string };
  type Props = { orgs: OrgSummary[]; activeOrgId?: number };
  let { orgs, activeOrgId }: Props = $props();

  const locale = $derived($page.data.locale as Locale);
  const activeOrg = $derived(orgs.find((o) => o.id === activeOrgId) ?? orgs[0]);

  function initials(name: string): string {
    const parts = name.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return '?';
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }

  let switching = $state(false);
  async function switchOrg(organizationId: number) {
    if (organizationId === activeOrg?.id || switching) return;
    switching = true;
    try {
      const res = await fetch('/api/orgs/switch', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ organizationId }),
      });
      if (!res.ok) {
        toast.error(t(locale, 'org-switcher.error-switch'));
        return;
      }
      await invalidateAll();
    } catch {
      toast.error(t(locale, 'org-switcher.error-switch'));
    } finally {
      switching = false;
    }
  }

  // Create-organization dialog.
  let createOpen = $state(false);
  let name = $state('');
  let creating = $state(false);
  const slug = $derived(
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, ''),
  );

  function openCreate() {
    name = '';
    createOpen = true;
  }

  async function createOrg() {
    const trimmed = name.trim();
    if (!trimmed || creating) return;
    creating = true;
    try {
      const res = await fetch('/api/orgs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ slug, name: trimmed }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.status === 409) {
        toast.error(t(locale, 'org-switcher.error-slug-taken'));
        return;
      }
      if (res.status === 400) {
        toast.error(t(locale, 'org-switcher.error-invalid-name'));
        return;
      }
      if (!res.ok) {
        toast.error(
          (body as { message?: string })?.message ?? t(locale, 'org-switcher.error-create-generic'),
        );
        return;
      }
      toast.success(t(locale, 'org-switcher.success-created', { name: trimmed }));
      createOpen = false;
      await invalidateAll();
    } catch {
      toast.error(t(locale, 'org-switcher.error-create-generic'));
    } finally {
      creating = false;
    }
  }
</script>

<DropdownMenu.Root>
  <DropdownMenu.Trigger>
    {#snippet child({ props })}
      <button
        {...props}
        class="flex w-full items-center gap-2 rounded-md border border-border bg-background px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Avatar.Root class="size-6 rounded-md">
          <Avatar.Fallback
            class="rounded-md bg-primary/10 text-[11px] font-semibold text-primary"
          >
            {initials(activeOrg?.name ?? '?')}
          </Avatar.Fallback>
        </Avatar.Root>
        <span class="flex-1 truncate font-medium">{activeOrg?.name ?? t(locale, 'org-switcher.label')}</span>
        <ChevronsUpDown class="size-4 shrink-0 text-muted-foreground" />
      </button>
    {/snippet}
  </DropdownMenu.Trigger>
  <DropdownMenu.Content class="w-56" align="start">
    <DropdownMenu.Label class="text-xs font-normal text-muted-foreground">
      {t(locale, 'org-switcher.organizations-label')}
    </DropdownMenu.Label>
    {#each orgs as org (org.id)}
      <DropdownMenu.Item class="gap-2" onclick={() => switchOrg(org.id)}>
        <Avatar.Root class="size-6 rounded-md">
          <Avatar.Fallback
            class="rounded-md bg-primary/10 text-[11px] font-semibold text-primary"
          >
            {initials(org.name)}
          </Avatar.Fallback>
        </Avatar.Root>
        <span class="flex-1 truncate">{org.name}</span>
        <span class="text-xs capitalize text-muted-foreground">{org.role}</span>
        {#if org.id === activeOrg?.id}
          <Check class="size-4 shrink-0 text-foreground" />
        {/if}
      </DropdownMenu.Item>
    {/each}
    <DropdownMenu.Separator />
    <DropdownMenu.Item class="gap-2" onclick={() => goto('/settings/organization')}>
      <Users class="size-4" />
      {t(locale, 'org-switcher.organization-link')}
    </DropdownMenu.Item>
    <DropdownMenu.Item class="gap-2" onclick={openCreate}>
      <Plus class="size-4" />
      {t(locale, 'org-switcher.create-link')}
    </DropdownMenu.Item>
  </DropdownMenu.Content>
</DropdownMenu.Root>

<Dialog.Root bind:open={createOpen}>
  <Dialog.Content class="sm:max-w-md">
    <Dialog.Header>
      <Dialog.Title>{t(locale, 'org-switcher.create-link')}</Dialog.Title>
      <Dialog.Description>
        {t(locale, 'org-switcher.create-description')}
      </Dialog.Description>
    </Dialog.Header>
    <div class="flex flex-col gap-2 py-2">
      <label for="org-name" class="text-sm font-medium">{t(locale, 'org-switcher.name-label')}</label>
      <Input
        id="org-name"
        bind:value={name}
        placeholder="Acme Inc."
        onkeydown={(e) => {
          if (e.key === 'Enter') createOrg();
        }}
      />
      {#if slug}
        <p class="text-xs text-muted-foreground">
          {t(locale, 'org-switcher.url-prefix')} <span class="font-mono text-foreground">{slug}</span>
        </p>
      {/if}
    </div>
    <Dialog.Footer>
      <Button variant="ghost" onclick={() => (createOpen = false)} disabled={creating}>
        {t(locale, 'org-switcher.cancel')}
      </Button>
      <Button onclick={createOrg} loading={creating} disabled={!slug}
        >{t(locale, 'org-switcher.create-button')}</Button
      >
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
