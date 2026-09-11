<script lang="ts">
  import * as Card from '$lib/components/ui/card';
  import * as Dialog from '$lib/components/ui/dialog';
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { page } from '$app/stores';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import Seo from '$lib/components/Seo.svelte';
  import { toast } from 'svelte-sonner';
  import { goto, invalidateAll } from '$app/navigation';
  import { UserPlus, Copy, Trash2, MoreHorizontal, Pencil } from '@lucide/svelte';
  import { untrack } from 'svelte';
  import { DOCS_URL } from '$lib/config/docs';
  import PageContainer from '$lib/components/PageContainer.svelte';
  import RemoveMemberDialog from '$lib/components/settings/RemoveMemberDialog.svelte';
  import LeaveOrgDialog from '$lib/components/settings/LeaveOrgDialog.svelte';
  import { t, tn, type Locale } from '$lib/i18n/index.js';

  const locale = $derived($page.data.locale as Locale);
  type Member = {
    userId: number;
    username: string;
    email: string | null;
    role: string;
    joinedAt: string;
  };
  type Invite = {
    token: string;
    role: string;
    email: string | null;
    expiresAt: string;
    createdAt: string;
  };
  type Org = { id: number; slug: string; name: string } | null;
  type OrgQuota = {
    monthlyRunBudgetUsd: number | null;
    maxConcurrentRuns: number | null;
    monthToDateCostUsd: number;
    campaignUsd: number;
    assistantUsd: number;
    remainingUsd: number | null;
  };
  type PageData = {
    authOn: boolean;
    org: Org;
    role: string | null;
    canManage: boolean;
    isOwner: boolean;
    currentUserId: number | null;
    members: Member[];
    invites: Invite[];
    quota: OrgQuota | null;
  };
  let { data }: { data: PageData } = $props();

  const ROLE_CAPS = $derived([
    {
      role: 'member',
      can: t(locale, 'settings.organization.role-caps.member-can'),
      cant: t(locale, 'settings.organization.role-caps.member-cant'),
    },
    {
      role: 'admin',
      can: t(locale, 'settings.organization.role-caps.admin-can'),
      cant: t(locale, 'settings.organization.role-caps.admin-cant'),
    },
    {
      role: 'owner',
      can: t(locale, 'settings.organization.role-caps.owner-can'),
      cant: null as string | null,
    },
  ]);

  const ROLES = ['member', 'admin', 'owner'] as const;
  const ROLE_HINT = $derived<Record<string, string>>({
    member: t(locale, 'settings.organization.role-hint.member'),
    admin: t(locale, 'settings.organization.role-hint.admin'),
    owner: t(locale, 'settings.organization.role-hint.owner'),
  });

  function initials(name: string): string {
    return (name.trim().slice(0, 2) || '?').toUpperCase();
  }
  function joinedLabel(iso: string): string {
    return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }
  function expiresLabel(iso: string): string {
    const days = Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000);
    if (days <= 0) return t(locale, 'settings.organization.expires-soon');
    return tn(locale, 'settings.organization.expires-in-days', days);
  }
  function inviteLink(token: string): string {
    return `${location.origin}/invite/${token}`;
  }
  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(t(locale, 'settings.organization.invite-link-copied'));
    } catch {
      toast.error(t(locale, 'settings.organization.copy-failed'));
    }
  }

  // Invite dialog.
  let inviteOpen = $state(false);
  let inviteRole = $state<(typeof ROLES)[number]>('member');
  let inviteEmail = $state('');
  let generating = $state(false);
  let generatedUrl = $state('');
  let generatedEmail = $state('');
  let generatedEmailSent = $state(false);

  function openInvite() {
    inviteRole = 'member';
    inviteEmail = '';
    generatedUrl = '';
    generatedEmail = '';
    generatedEmailSent = false;
    inviteOpen = true;
  }

  async function generateInvite() {
    if (!data.org || generating) return;
    generating = true;
    try {
      const email = inviteEmail.trim();
      const res = await fetch(`/api/orgs/${data.org.slug}/invites`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ role: inviteRole, ...(email ? { email } : {}) }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        url?: string;
        emailSent?: boolean;
        error?: string;
      };
      if (!res.ok) {
        toast.error(
          body?.error === 'not_found'
            ? t(locale, 'settings.organization.error-invite-forbidden')
            : body?.error === 'invalid_body'
              ? t(locale, 'settings.organization.error-invalid-email')
              : t(locale, 'settings.organization.error-invite-failed'),
        );
        return;
      }
      generatedUrl = body.url ?? '';
      generatedEmail = email;
      generatedEmailSent = body.emailSent ?? false;
      if (generatedEmailSent)
        toast.success(t(locale, 'settings.organization.invite-sent-to', { email }));
      await invalidateAll();
    } catch {
      toast.error(t(locale, 'settings.organization.error-invite-failed'));
    } finally {
      generating = false;
    }
  }

  let revoking = $state<string | null>(null);
  async function revoke(token: string) {
    if (!data.org || revoking) return;
    revoking = token;
    try {
      const res = await fetch(`/api/orgs/${data.org.slug}/invites/${token}`, { method: 'DELETE' });
      if (!res.ok) {
        toast.error(t(locale, 'settings.organization.error-revoke-invite-failed'));
        return;
      }
      toast.success(t(locale, 'settings.organization.invite-revoked'));
      await invalidateAll();
    } catch {
      toast.error(t(locale, 'settings.organization.error-revoke-invite-failed'));
    } finally {
      revoking = null;
    }
  }

  // Member management: what the current user (role in data.role) may do to a
  // target. Admins cannot touch owners and cannot grant the owner role; the API
  // enforces the same rules, this just hides controls that would 403.
  function canActOn(targetRole: string): boolean {
    if (!data.canManage) return false;
    if (data.role === 'owner') return true;
    return data.role === 'admin' && targetRole !== 'owner';
  }
  function assignableRoles(): string[] {
    return data.role === 'owner' ? ['member', 'admin', 'owner'] : ['member', 'admin'];
  }

  let acting = $state<number | null>(null);
  async function changeRole(userId: number, role: string) {
    if (!data.org || acting) return;
    acting = userId;
    try {
      const res = await fetch(`/api/orgs/${data.org.slug}/members/${userId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ role }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        toast.error(
          res.status === 403 || res.status === 400
            ? (body.error ?? t(locale, 'settings.organization.error-not-allowed'))
            : t(locale, 'settings.organization.error-change-role-failed'),
        );
        return;
      }
      toast.success(t(locale, 'settings.organization.role-updated'));
      await invalidateAll();
    } catch {
      toast.error(t(locale, 'settings.organization.error-change-role-failed'));
    } finally {
      acting = null;
    }
  }

  let removeMemberDialogOpen = $state(false);
  let removeMemberTarget = $state<{ userId: number; username: string } | null>(null);

  function openRemoveMemberDialog(userId: number, username: string) {
    removeMemberTarget = { userId, username };
    removeMemberDialogOpen = true;
  }

  async function removeMemberAction() {
    if (!data.org || !removeMemberTarget || acting) return;
    const { userId, username } = removeMemberTarget;
    acting = userId;
    try {
      const res = await fetch(`/api/orgs/${data.org.slug}/members/${userId}`, { method: 'DELETE' });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        toast.error(
          res.status === 403 || res.status === 400
            ? (body.error ?? t(locale, 'settings.organization.error-not-allowed'))
            : t(locale, 'settings.organization.error-remove-member-failed'),
        );
        return;
      }
      toast.success(t(locale, 'settings.organization.member-removed', { username }));
      removeMemberDialogOpen = false;
      removeMemberTarget = null;
      await invalidateAll();
    } catch {
      toast.error(t(locale, 'settings.organization.error-remove-member-failed'));
    } finally {
      acting = null;
    }
  }

  // Rename the organization (admin+).
  let editingName = $state(false);
  let nameDraft = $state('');
  let renaming = $state(false);
  function startRename() {
    nameDraft = data.org?.name ?? '';
    editingName = true;
  }
  async function saveName() {
    if (!data.org || renaming) return;
    const name = nameDraft.trim();
    if (!name) {
      toast.error(t(locale, 'settings.organization.error-name-required'));
      return;
    }
    renaming = true;
    try {
      const res = await fetch(`/api/orgs/${data.org.slug}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        toast.error(
          res.status === 404
            ? t(locale, 'settings.organization.error-admin-required-rename')
            : (body.error ?? t(locale, 'settings.organization.error-rename-failed')),
        );
        return;
      }
      toast.success(t(locale, 'settings.organization.org-renamed'));
      editingName = false;
      await invalidateAll();
    } catch {
      toast.error(t(locale, 'settings.organization.error-rename-failed'));
    } finally {
      renaming = false;
    }
  }

  // Quota & budget (admin+): monthly USD run budget and concurrent-run cap
  // stored on organizations.monthly_run_budget_usd / max_concurrent_runs
  // (#161). Blank input means unlimited (null). Draft strings are kept
  // separate from data.quota so a blank field isn't coerced to 0 while typing.
  function toDraft(n: number | null): string {
    return n == null ? '' : String(n);
  }
  let budgetDraft = $state(untrack(() => toDraft(data.quota?.monthlyRunBudgetUsd ?? null)));
  let capDraft = $state(untrack(() => toDraft(data.quota?.maxConcurrentRuns ?? null)));
  let savingQuota = $state(false);

  function money(n: number): string {
    return n.toLocaleString(undefined, { style: 'currency', currency: 'USD' });
  }

  async function saveQuota() {
    if (savingQuota) return;
    const budgetRaw = budgetDraft.trim();
    const capRaw = capDraft.trim();
    if (budgetRaw !== '' && Number(budgetRaw) < 0) {
      toast.error(t(locale, 'settings.organization.error-budget-negative'));
      return;
    }
    if (capRaw !== '' && Number(capRaw) < 0) {
      toast.error(t(locale, 'settings.organization.error-cap-negative'));
      return;
    }
    savingQuota = true;
    try {
      const res = await fetch('/api/settings/org-quota', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          monthlyRunBudgetUsd: budgetRaw === '' ? null : Number(budgetRaw),
          maxConcurrentRuns: capRaw === '' ? null : Number(capRaw),
        }),
      });
      if (!res.ok) {
        toast.error(
          res.status === 403
            ? t(locale, 'settings.organization.error-admin-required')
            : t(locale, 'settings.organization.error-quota-save-failed'),
        );
        return;
      }
      toast.success(t(locale, 'settings.organization.quota-saved'));
      await invalidateAll();
    } catch {
      toast.error(t(locale, 'settings.organization.error-quota-save-failed'));
    } finally {
      savingQuota = false;
    }
  }

  // Leave the organization (self-remove), guarded by a typed-name confirmation.
  let leaving = $state(false);
  let leaveDialogOpen = $state(false);
  async function leaveOrg() {
    if (!data.org || leaving) return;
    leaving = true;
    try {
      const res = await fetch(`/api/orgs/${data.org.slug}/leave`, { method: 'POST' });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        toast.error(
          res.status === 400
            ? (body.error ?? t(locale, 'settings.organization.error-cannot-leave'))
            : t(locale, 'settings.organization.error-leave-failed'),
        );
        return;
      }
      toast.success(t(locale, 'settings.organization.left-org'));
      leaveDialogOpen = false;
      await goto('/', { invalidateAll: true });
    } catch {
      toast.error(t(locale, 'settings.organization.error-leave-failed'));
    } finally {
      leaving = false;
    }
  }

  // Delete the organization (owner only), guarded by a typed-name confirmation.
  let deleteOpen = $state(false);
  let deleteConfirm = $state('');
  let deleting = $state(false);
  async function deleteOrg() {
    if (!data.org || deleting) return;
    deleting = true;
    try {
      const res = await fetch(`/api/orgs/${data.org.slug}`, { method: 'DELETE' });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        toast.error(
          res.status === 403
            ? t(locale, 'settings.organization.error-only-owner-deletes')
            : (body.error ?? t(locale, 'settings.organization.error-delete-failed')),
        );
        return;
      }
      toast.success(t(locale, 'settings.organization.org-deleted'));
      deleteOpen = false;
      await goto('/', { invalidateAll: true });
    } catch {
      toast.error(t(locale, 'settings.organization.error-delete-failed'));
    } finally {
      deleting = false;
    }
  }
</script>

<PageContainer size="default">
<Seo
  title={t(locale, 'settings.organization.seo-title')}
  description={t(locale, 'settings.organization.seo-description')}
/>

<PageHeader
  title={t(locale, 'settings.organization.title')}
  description={data.org ? data.org.name : t(locale, 'settings.organization.description-no-org')}
/>

{#if !data.org}
  <Card.Root class="mt-4">
    <Card.Content class="py-6 text-sm text-muted-foreground">
      {#if data.authOn}
        {t(locale, 'settings.organization.sign-in-prompt')}
      {:else}
        {t(locale, 'settings.organization.auth-off-lead')}
        <a
          href="{DOCS_URL}auth"
          target="_blank"
          rel="noopener"
          class="underline hover:no-underline"
          >{t(locale, 'settings.organization.auth-off-link')}</a
        >
        {t(locale, 'settings.organization.auth-off-tail')}
      {/if}
    </Card.Content>
  </Card.Root>
{:else}
  <div class="mt-4 flex flex-col gap-4">
    <Card.Root>
      <Card.Header>
        <Card.Title class="text-base">{t(locale, 'settings.organization.card-title')}</Card.Title>
      </Card.Header>
      <Card.Content class="flex flex-col gap-4">
        <div class="flex flex-col gap-1.5">
          <span class="text-sm font-medium">{t(locale, 'settings.organization.name-label')}</span>
          {#if data.canManage && editingName}
            <div class="flex flex-wrap gap-2">
              <Input
                bind:value={nameDraft}
                maxlength={80}
                class="max-w-xs"
                onkeydown={(e) => {
                  if (e.key === 'Enter') saveName();
                  if (e.key === 'Escape') editingName = false;
                }}
              />
              <Button onclick={saveName} loading={renaming}
                >{t(locale, 'settings.organization.save')}</Button
              >
              <Button variant="ghost" onclick={() => (editingName = false)} disabled={renaming}>
                {t(locale, 'settings.organization.cancel')}
              </Button>
            </div>
          {:else}
            <div class="flex items-center gap-2">
              <span class="text-sm">{data.org.name}</span>
              {#if data.canManage}
                <Button variant="ghost" size="sm" onclick={startRename}>
                  <Pencil class="size-3.5" />
                  {t(locale, 'settings.organization.rename')}
                </Button>
              {/if}
            </div>
          {/if}
        </div>
        <div class="flex flex-col gap-1">
          <span class="text-sm font-medium">{t(locale, 'settings.organization.url-slug-label')}</span>
          <span class="font-mono text-xs text-muted-foreground">{data.org.slug}</span>
        </div>
      </Card.Content>
    </Card.Root>

    {#if data.canManage && data.quota}
      <Card.Root>
        <Card.Header>
          <Card.Title class="text-base">{t(locale, 'settings.organization.quota-title')}</Card.Title>
          <p class="text-sm text-muted-foreground">
            {t(locale, 'settings.organization.quota-description')}
          </p>
        </Card.Header>
        <Card.Content class="flex flex-col gap-4">
          <div class="grid gap-4 sm:grid-cols-2">
            <div class="flex flex-col gap-1.5">
              <label class="text-sm font-medium" for="monthly-budget"
                >{t(locale, 'settings.organization.monthly-budget-label')}</label
              >
              <Input
                id="monthly-budget"
                type="number"
                min="0"
                step="0.01"
                placeholder={t(locale, 'settings.organization.unlimited')}
                bind:value={budgetDraft}
              />
            </div>
            <div class="flex flex-col gap-1.5">
              <label class="text-sm font-medium" for="max-concurrent-runs"
                >{t(locale, 'settings.organization.max-concurrent-label')}</label
              >
              <Input
                id="max-concurrent-runs"
                type="number"
                min="0"
                step="1"
                placeholder={t(locale, 'settings.organization.unlimited')}
                bind:value={capDraft}
              />
            </div>
          </div>
          <div class="grid gap-4 sm:grid-cols-2">
            <div class="flex flex-col gap-1">
              <span class="text-sm font-medium">{t(locale, 'settings.organization.month-to-date-label')}</span>
              <span class="text-sm text-muted-foreground">{money(data.quota.monthToDateCostUsd)}</span>
            </div>
            <div class="flex flex-col gap-1">
              <span class="text-sm font-medium">{t(locale, 'settings.organization.remaining-budget-label')}</span>
              <span class="text-sm text-muted-foreground">
                {data.quota.remainingUsd == null
                  ? t(locale, 'settings.organization.unlimited')
                  : money(data.quota.remainingUsd)}
              </span>
            </div>
            <div class="flex flex-col gap-1">
              <span class="text-sm font-medium">{t(locale, 'settings.organization.campaign-spend-label')}</span>
              <span class="text-sm text-muted-foreground">{money(data.quota.campaignUsd)}</span>
            </div>
            <div class="flex flex-col gap-1">
              <span class="text-sm font-medium">{t(locale, 'settings.organization.assistant-spend-label')}</span>
              <span class="text-sm text-muted-foreground">
                {money(data.quota.assistantUsd)}
                {t(locale, 'settings.organization.assistant-spend-note')}
              </span>
            </div>
          </div>
          <div>
            <Button onclick={saveQuota} loading={savingQuota}
              >{t(locale, 'settings.organization.save')}</Button
            >
          </div>
        </Card.Content>
      </Card.Root>
    {/if}

    <Card.Root>
      <Card.Header>
        <Card.Title class="text-base">{t(locale, 'settings.organization.roles-title')}</Card.Title>
        <p class="text-sm text-muted-foreground">{t(locale, 'settings.organization.roles-description')}</p>
      </Card.Header>
      <Card.Content class="flex flex-col divide-y divide-border">
        {#each ROLE_CAPS as rc (rc.role)}
          <div class="flex flex-col gap-1 py-3 first:pt-0 last:pb-0">
            <span
              class="w-fit rounded-full border border-border px-2 py-0.5 text-xs font-medium capitalize text-foreground"
            >
              {rc.role}
            </span>
            <p class="text-sm">{rc.can}</p>
            {#if rc.cant}
              <p class="text-xs text-muted-foreground">
                {t(locale, 'settings.organization.cannot-prefix')}
                {rc.cant}
              </p>
            {/if}
          </div>
        {/each}
      </Card.Content>
    </Card.Root>

    <Card.Root>
      <Card.Header class="flex flex-row items-center justify-between space-y-0">
        <div class="min-w-0">
          <Card.Title class="text-base">{t(locale, 'settings.organization.members-title')}</Card.Title>
          <p class="text-sm text-muted-foreground">
            {data.members.length}
            {tn(locale, 'settings.organization.people-count', data.members.length)}
            {t(locale, 'settings.organization.people-in-org', { org: data.org.name })}
          </p>
        </div>
        {#if data.canManage}
          <Button size="sm" onclick={openInvite}>
            <UserPlus class="size-4" />
            {t(locale, 'settings.organization.invite-member')}
          </Button>
        {/if}
      </Card.Header>
      <Card.Content class="flex flex-col divide-y divide-border">
        {#each data.members as m (m.userId)}
          <div class="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0">
            <span
              class="grid size-7 flex-none place-items-center rounded-md bg-primary/10 text-[11px] font-semibold text-primary"
            >
              {initials(m.username)}
            </span>
            <span class="min-w-0 flex-1">
              <span class="block truncate text-sm font-medium">
                {m.username}
                {#if m.userId === data.currentUserId}
                  <span class="font-normal text-muted-foreground"
                    >{t(locale, 'settings.organization.you-suffix')}</span
                  >
                {/if}
              </span>
              {#if m.email}
                <span class="block truncate text-xs text-muted-foreground">{m.email}</span>
              {/if}
            </span>
            <span
              class="rounded-full border border-border px-2 py-0.5 text-xs capitalize text-muted-foreground"
            >
              {m.role}
            </span>
            <span class="hidden text-xs text-muted-foreground sm:inline"
              >{t(locale, 'settings.organization.joined-on', { date: joinedLabel(m.joinedAt) })}</span
            >
            {#if m.userId !== data.currentUserId && canActOn(m.role)}
              <DropdownMenu.Root>
                <DropdownMenu.Trigger>
                  {#snippet child({ props })}
                    <button
                      {...props}
                      class="grid size-7 flex-none place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                      aria-label={t(locale, 'settings.organization.manage-member', { name: m.username })}
                    >
                      <MoreHorizontal class="size-4" />
                    </button>
                  {/snippet}
                </DropdownMenu.Trigger>
                <DropdownMenu.Content align="end" class="w-52">
                  <DropdownMenu.Label class="text-xs font-normal text-muted-foreground">
                    {t(locale, 'settings.organization.change-role')}
                  </DropdownMenu.Label>
                  {#each assignableRoles() as r (r)}
                    {#if r !== m.role}
                      <DropdownMenu.Item class="capitalize" onclick={() => changeRole(m.userId, r)}>
                        {t(locale, 'settings.organization.make-role', { role: r })}
                      </DropdownMenu.Item>
                    {/if}
                  {/each}
                  <DropdownMenu.Separator />
                  <DropdownMenu.Item
                    class="gap-2 text-destructive"
                    onclick={() => openRemoveMemberDialog(m.userId, m.username)}
                  >
                    <Trash2 class="size-4" />
                    {t(locale, 'settings.organization.remove-from-org')}
                  </DropdownMenu.Item>
                </DropdownMenu.Content>
              </DropdownMenu.Root>
            {/if}
          </div>
        {/each}
      </Card.Content>
    </Card.Root>

    {#if data.canManage}
      <Card.Root>
        <Card.Header>
          <Card.Title class="text-base">{t(locale, 'settings.organization.pending-invites-title')}</Card.Title>
          <p class="text-sm text-muted-foreground">{t(locale, 'settings.organization.pending-invites-description')}</p>
        </Card.Header>
        <Card.Content>
          {#if data.invites.length === 0}
            <p class="py-1 text-sm text-muted-foreground">{t(locale, 'settings.organization.no-pending-invites')}</p>
          {:else}
            <div class="flex flex-col divide-y divide-border">
              {#each data.invites as inv (inv.token)}
                <div class="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0">
                  <span
                    class="rounded-full border border-border px-2 py-0.5 text-xs capitalize text-muted-foreground"
                  >
                    {inv.role}
                  </span>
                  <span class="flex-1 truncate text-sm text-muted-foreground">
                    {t(locale, 'settings.organization.expires-label', { time: expiresLabel(inv.expiresAt) })}
                  </span>
                  <Button variant="ghost" size="sm" onclick={() => copy(inviteLink(inv.token))}>
                    <Copy class="size-3.5" />
                    {t(locale, 'settings.organization.copy-link')}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    class="text-destructive hover:text-destructive"
                    onclick={() => revoke(inv.token)}
                    loading={revoking === inv.token}
                  >
                    <Trash2 class="size-3.5" />
                    {t(locale, 'settings.organization.revoke')}
                  </Button>
                </div>
              {/each}
            </div>
          {/if}
        </Card.Content>
      </Card.Root>
    {/if}

    <Card.Root class="border-destructive/40">
      <Card.Header>
        <Card.Title class="text-base text-destructive">{t(locale, 'settings.organization.danger-zone-title')}</Card.Title>
      </Card.Header>
      <Card.Content class="flex flex-col gap-3">
        <div class="flex flex-wrap items-center justify-between gap-3">
          <div class="min-w-0">
            <p class="text-sm font-medium">{t(locale, 'settings.organization.leave-org-title')}</p>
            <p class="text-xs text-muted-foreground">
              {t(locale, 'settings.organization.leave-org-description', { org: data.org.name })}
            </p>
          </div>
          <Button variant="outline" onclick={() => (leaveDialogOpen = true)} loading={leaving}
            >{t(locale, 'settings.organization.leave')}</Button
          >
        </div>
        {#if data.isOwner && data.org.slug !== 'default'}
          <div
            class="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3"
          >
            <div class="min-w-0">
              <p class="text-sm font-medium text-destructive">
                {t(locale, 'settings.organization.delete-org-title')}
              </p>
              <p class="text-xs text-muted-foreground">
                {t(locale, 'settings.organization.delete-org-description', { org: data.org.name })}
              </p>
            </div>
            <Button
              variant="outline"
              class="border-destructive/50 text-destructive hover:bg-destructive/10"
              onclick={() => {
                deleteConfirm = '';
                deleteOpen = true;
              }}
            >
              {t(locale, 'settings.organization.delete')}
            </Button>
          </div>
        {/if}
      </Card.Content>
    </Card.Root>
  </div>
{/if}

<Dialog.Root bind:open={inviteOpen}>
  <Dialog.Content class="sm:max-w-md">
    <Dialog.Header>
      <Dialog.Title>{t(locale, 'settings.organization.invite-dialog-title')}</Dialog.Title>
      <Dialog.Description>
        {t(locale, 'settings.organization.invite-dialog-description')}
      </Dialog.Description>
    </Dialog.Header>
    <div class="flex flex-col gap-4 py-2">
      <div class="flex flex-col gap-2">
        <span class="text-sm font-medium">{t(locale, 'settings.organization.role-label')}</span>
        <div class="grid grid-cols-3 gap-2">
          {#each ROLES as r (r)}
            <button
              type="button"
              class={`rounded-md border px-3 py-2 text-sm capitalize transition-colors ${
                inviteRole === r
                  ? 'border-foreground bg-accent font-medium text-foreground'
                  : 'border-border text-muted-foreground hover:bg-accent/50'
              }`}
              onclick={() => (inviteRole = r)}
            >
              {r}
            </button>
          {/each}
        </div>
        <p class="text-xs text-muted-foreground">{ROLE_HINT[inviteRole]}</p>
      </div>

      <div class="flex flex-col gap-2">
        <span class="text-sm font-medium">{t(locale, 'settings.organization.email-optional-label')}</span>
        <Input
          type="email"
          placeholder="person@example.com"
          bind:value={inviteEmail}
          disabled={!!generatedUrl}
        />
        <p class="text-xs text-muted-foreground">
          {t(locale, 'settings.organization.email-not-configured-note')}
        </p>
      </div>

      {#if generatedUrl}
        <div class="flex flex-col gap-2">
          <span class="text-sm font-medium">{t(locale, 'settings.organization.invite-link-label')}</span>
          <div class="flex gap-2">
            <Input value={generatedUrl} readonly onfocus={(e) => e.currentTarget.select()} />
            <Button
              variant="outline"
              onclick={() => copy(generatedUrl)}
              aria-label={t(locale, 'settings.organization.copy-link-aria')}
            >
              <Copy class="size-4" />
            </Button>
          </div>
          <p class="text-xs text-muted-foreground">
            {#if generatedEmail && generatedEmailSent}
              {t(locale, 'settings.organization.invite-sent-note', { email: generatedEmail })}
            {:else if generatedEmail && !generatedEmailSent}
              {t(locale, 'settings.organization.invite-mail-not-configured', { email: generatedEmail })}
            {:else}
              {t(locale, 'settings.organization.invite-anyone-note-lead')}
              <span class="capitalize">{inviteRole}</span>.
            {/if}
          </p>
        </div>
      {/if}
    </div>
    <Dialog.Footer>
      {#if generatedUrl}
        <Button variant="ghost" onclick={() => (generatedUrl = '')}
          >{t(locale, 'settings.organization.generate-another')}</Button
        >
        <Button onclick={() => (inviteOpen = false)}>{t(locale, 'settings.organization.done')}</Button>
      {:else}
        <Button variant="ghost" onclick={() => (inviteOpen = false)}
          >{t(locale, 'settings.organization.cancel')}</Button
        >
        <Button onclick={generateInvite} loading={generating}>
          {inviteEmail.trim()
            ? t(locale, 'settings.organization.send-invite')
            : t(locale, 'settings.organization.generate-link')}
        </Button>
      {/if}
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>

<Dialog.Root bind:open={deleteOpen}>
  <Dialog.Content class="sm:max-w-md">
    <Dialog.Header>
      <Dialog.Title>{t(locale, 'settings.organization.delete-org-title')}</Dialog.Title>
      <Dialog.Description>
        {t(locale, 'settings.organization.delete-dialog-description', { org: data.org?.name ?? '' })}
      </Dialog.Description>
    </Dialog.Header>
    <div class="flex flex-col gap-2 py-2">
      <label for="del-confirm" class="text-sm">
        {t(locale, 'settings.organization.type-to-confirm-lead')}
        <span class="font-medium">{data.org?.name}</span>
        {t(locale, 'settings.organization.type-to-confirm-tail')}
      </label>
      <Input id="del-confirm" bind:value={deleteConfirm} placeholder={data.org?.name} />
    </div>
    <Dialog.Footer>
      <Button variant="ghost" onclick={() => (deleteOpen = false)} disabled={deleting}
        >{t(locale, 'settings.organization.cancel')}</Button
      >
      <Button
        variant="destructive"
        onclick={deleteOrg}
        loading={deleting}
        disabled={deleteConfirm !== data.org?.name}
      >
        {t(locale, 'settings.organization.delete-org-title')}
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>

<RemoveMemberDialog
  bind:open={removeMemberDialogOpen}
  name={removeMemberTarget?.username ?? ''}
  orgName={data.org?.name ?? ''}
  onConfirm={removeMemberAction}
  onClose={() => (removeMemberDialogOpen = false)}
/>

<LeaveOrgDialog
  bind:open={leaveDialogOpen}
  name={data.org?.name ?? ''}
  onConfirm={leaveOrg}
  onClose={() => (leaveDialogOpen = false)}
/>
</PageContainer>
