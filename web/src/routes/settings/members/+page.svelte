<script lang="ts">
  import * as Card from '$lib/components/ui/card';
  import * as Dialog from '$lib/components/ui/dialog';
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import Seo from '$lib/components/Seo.svelte';
  import { toast } from 'svelte-sonner';
  import { invalidateAll } from '$app/navigation';
  import { UserPlus, Copy, Trash2, MoreHorizontal } from '@lucide/svelte';

  type Member = { userId: number; username: string; role: string; joinedAt: string };
  type Invite = {
    token: string;
    role: string;
    email: string | null;
    expiresAt: string;
    createdAt: string;
  };
  type Org = { id: number; slug: string; name: string } | null;
  type PageData = {
    org: Org;
    role: string | null;
    canManage: boolean;
    currentUserId: number | null;
    members: Member[];
    invites: Invite[];
  };
  let { data }: { data: PageData } = $props();

  const ROLES = ['member', 'admin', 'owner'] as const;
  const ROLE_HINT: Record<string, string> = {
    member: 'Can view and work in the organization.',
    admin: 'Can also invite people and manage members.',
    owner: 'Full control, including billing and deletion.',
  };

  function initials(name: string): string {
    return (name.trim().slice(0, 2) || '?').toUpperCase();
  }
  function joinedLabel(iso: string): string {
    return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }
  function expiresLabel(iso: string): string {
    const days = Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000);
    if (days <= 0) return 'soon';
    return `in ${days} day${days === 1 ? '' : 's'}`;
  }
  function inviteLink(token: string): string {
    return `${location.origin}/invite/${token}`;
  }
  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast.success('Invite link copied');
    } catch {
      toast.error('Could not copy, select the link and copy it manually');
    }
  }

  // Invite dialog.
  let inviteOpen = $state(false);
  let inviteRole = $state<(typeof ROLES)[number]>('member');
  let generating = $state(false);
  let generatedUrl = $state('');

  function openInvite() {
    inviteRole = 'member';
    generatedUrl = '';
    inviteOpen = true;
  }

  async function generateInvite() {
    if (!data.org || generating) return;
    generating = true;
    try {
      const res = await fetch(`/api/orgs/${data.org.slug}/invites`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ role: inviteRole }),
      });
      const body = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
      if (!res.ok) {
        toast.error(
          body?.error === 'not_found'
            ? 'Only owners and admins can invite people'
            : 'Could not create the invite',
        );
        return;
      }
      generatedUrl = body.url ?? '';
      await invalidateAll();
    } catch {
      toast.error('Could not create the invite');
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
        toast.error('Could not revoke the invite');
        return;
      }
      toast.success('Invite revoked');
      await invalidateAll();
    } catch {
      toast.error('Could not revoke the invite');
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
          res.status === 403 || res.status === 400 ? (body.error ?? 'Not allowed') : 'Could not change the role',
        );
        return;
      }
      toast.success('Role updated');
      await invalidateAll();
    } catch {
      toast.error('Could not change the role');
    } finally {
      acting = null;
    }
  }
  async function removeMemberAction(userId: number, username: string) {
    if (!data.org || acting) return;
    if (!confirm(`Remove ${username} from ${data.org.name}?`)) return;
    acting = userId;
    try {
      const res = await fetch(`/api/orgs/${data.org.slug}/members/${userId}`, { method: 'DELETE' });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        toast.error(
          res.status === 403 || res.status === 400 ? (body.error ?? 'Not allowed') : 'Could not remove the member',
        );
        return;
      }
      toast.success(`${username} removed`);
      await invalidateAll();
    } catch {
      toast.error('Could not remove the member');
    } finally {
      acting = null;
    }
  }
</script>

<Seo title="Settings - Members" description="People in your organization and pending invites." />

<PageHeader
  title="Members"
  description={data.org
    ? `People in ${data.org.name} and pending invites.`
    : 'Organization members.'}
/>

{#if !data.org}
  <Card.Root class="mt-4">
    <Card.Content class="py-6 text-sm text-muted-foreground">
      Sign in to see and manage the people in your organization.
    </Card.Content>
  </Card.Root>
{:else}
  <div class="mt-4 flex flex-col gap-4">
    <Card.Root>
      <Card.Header class="flex flex-row items-center justify-between space-y-0">
        <div class="min-w-0">
          <Card.Title class="text-base">Members</Card.Title>
          <p class="text-sm text-muted-foreground">
            {data.members.length}
            {data.members.length === 1 ? 'person' : 'people'} in {data.org.name}
          </p>
        </div>
        {#if data.canManage}
          <Button size="sm" onclick={openInvite}>
            <UserPlus class="size-4" />
            Invite member
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
            <span class="flex-1 truncate text-sm font-medium">
              {m.username}
              {#if m.userId === data.currentUserId}
                <span class="font-normal text-muted-foreground">(you)</span>
              {/if}
            </span>
            <span
              class="rounded-full border border-border px-2 py-0.5 text-xs capitalize text-muted-foreground"
            >
              {m.role}
            </span>
            <span class="hidden text-xs text-muted-foreground sm:inline"
              >joined {joinedLabel(m.joinedAt)}</span
            >
            {#if m.userId !== data.currentUserId && canActOn(m.role)}
              <DropdownMenu.Root>
                <DropdownMenu.Trigger>
                  {#snippet child({ props })}
                    <button
                      {...props}
                      class="grid size-7 flex-none place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                      aria-label={`Manage ${m.username}`}
                    >
                      <MoreHorizontal class="size-4" />
                    </button>
                  {/snippet}
                </DropdownMenu.Trigger>
                <DropdownMenu.Content align="end" class="w-52">
                  <DropdownMenu.Label class="text-xs font-normal text-muted-foreground">
                    Change role
                  </DropdownMenu.Label>
                  {#each assignableRoles() as r (r)}
                    {#if r !== m.role}
                      <DropdownMenu.Item class="capitalize" onclick={() => changeRole(m.userId, r)}>
                        Make {r}
                      </DropdownMenu.Item>
                    {/if}
                  {/each}
                  <DropdownMenu.Separator />
                  <DropdownMenu.Item
                    class="gap-2 text-destructive"
                    onclick={() => removeMemberAction(m.userId, m.username)}
                  >
                    <Trash2 class="size-4" />
                    Remove from organization
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
          <Card.Title class="text-base">Pending invites</Card.Title>
          <p class="text-sm text-muted-foreground">Links that have not been accepted yet.</p>
        </Card.Header>
        <Card.Content>
          {#if data.invites.length === 0}
            <p class="py-1 text-sm text-muted-foreground">No pending invites.</p>
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
                    expires {expiresLabel(inv.expiresAt)}
                  </span>
                  <Button variant="ghost" size="sm" onclick={() => copy(inviteLink(inv.token))}>
                    <Copy class="size-3.5" />
                    Copy link
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    class="text-destructive hover:text-destructive"
                    onclick={() => revoke(inv.token)}
                    loading={revoking === inv.token}
                  >
                    <Trash2 class="size-3.5" />
                    Revoke
                  </Button>
                </div>
              {/each}
            </div>
          {/if}
        </Card.Content>
      </Card.Root>
    {/if}
  </div>
{/if}

<Dialog.Root bind:open={inviteOpen}>
  <Dialog.Content class="sm:max-w-md">
    <Dialog.Header>
      <Dialog.Title>Invite a member</Dialog.Title>
      <Dialog.Description>
        Pick a role, then share the generated link. It expires in 7 days.
      </Dialog.Description>
    </Dialog.Header>
    <div class="flex flex-col gap-4 py-2">
      <div class="flex flex-col gap-2">
        <span class="text-sm font-medium">Role</span>
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

      {#if generatedUrl}
        <div class="flex flex-col gap-2">
          <span class="text-sm font-medium">Invite link</span>
          <div class="flex gap-2">
            <Input value={generatedUrl} readonly onfocus={(e) => e.currentTarget.select()} />
            <Button variant="outline" onclick={() => copy(generatedUrl)} aria-label="Copy link">
              <Copy class="size-4" />
            </Button>
          </div>
          <p class="text-xs text-muted-foreground">
            Anyone with this link can join as <span class="capitalize">{inviteRole}</span>.
          </p>
        </div>
      {/if}
    </div>
    <Dialog.Footer>
      {#if generatedUrl}
        <Button variant="ghost" onclick={() => (generatedUrl = '')}>Generate another</Button>
        <Button onclick={() => (inviteOpen = false)}>Done</Button>
      {:else}
        <Button variant="ghost" onclick={() => (inviteOpen = false)}>Cancel</Button>
        <Button onclick={generateInvite} loading={generating}>Generate link</Button>
      {/if}
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
