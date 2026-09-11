<script lang="ts">
  import { page } from '$app/stores';
  import { invalidateAll } from '$app/navigation';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { SelectField } from '$lib/components/ui/select-field';
  import { toast } from 'svelte-sonner';
  import { TONE_CLASS } from '$lib/config/status-badges';
  import DeleteAccountDialog from './DeleteAccountDialog.svelte';
  import { t, type Locale } from '$lib/i18n/index.js';

  type Account = {
    id: number;
    handle: string;
    role: string;
    platformId: number;
    isDefault: boolean;
    dailyLimit: number | null;
    weeklyLimit: number | null;
  };
  type Platform = { id: number; slug: string };
  type PlatformDefaults = { daily: number; weekly: number };
  type Props = {
    projectId: number;
    accounts: Account[];
    platforms: Platform[];
    platformDefaults?: Record<number, PlatformDefaults>;
    isAdmin: boolean;
  };
  let { projectId, accounts, platforms, platformDefaults = {}, isAdmin }: Props = $props();

  const locale = $derived($page.data.locale as Locale);
  const ROLE_OPTIONS = $derived([
    { value: 'personal', label: t(locale, 'projects.role-personal') },
    { value: 'brand', label: t(locale, 'projects.role-brand') },
  ]);

  let addOpen = $state(false);
  let newHandle = $state('');
  let newRole = $state<'personal' | 'brand'>('personal');
  // svelte-ignore state_referenced_locally
  let newPlatform = $state(platforms[0]?.slug ?? 'reddit');
  let newInstanceUrl = $state('');
  let newAccessToken = $state('');
  let newDisplayName = $state('');
  let busy = $state(false);

  let isMastodon = $derived(newPlatform === 'mastodon');
  let isLinkedin = $derived(newPlatform === 'linkedin');

  function platformSlug(id: number) {
    return platforms.find((p) => p.id === id)?.slug ?? `#${id}`;
  }

  async function add() {
    busy = true;
    try {
      const res = isMastodon
        ? await fetch(`/api/projects/${projectId}/accounts/mastodon`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              instanceUrl: newInstanceUrl,
              accessToken: newAccessToken,
              role: newRole,
            }),
          })
        : await fetch(`/api/projects/${projectId}/accounts`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              handle: newHandle,
              role: newRole,
              platformSlug: newPlatform,
              displayName: newDisplayName.trim() || undefined,
            }),
          });
      if (!res.ok) {
        if (res.status === 403) {
          toast.error(t(locale, 'projects.error-admin-required'));
        } else if (isMastodon && res.status === 400) {
          const body = await res.json().catch(() => null);
          toast.error(body?.message ?? t(locale, 'projects.error-mastodon-verify-failed'));
        } else {
          toast.error(t(locale, 'projects.error-add-account-failed'));
        }
        return;
      }
      newHandle = '';
      newInstanceUrl = '';
      newAccessToken = '';
      newDisplayName = '';
      addOpen = false;
      await invalidateAll();
    } finally {
      busy = false;
    }
  }

  let deleteDialogOpen = $state(false);
  let deleteTarget = $state<Account | null>(null);

  function openDeleteDialog(a: Account) {
    deleteTarget = a;
    deleteDialogOpen = true;
  }

  async function confirmRemove() {
    if (!deleteTarget) return;
    const res = await fetch(`/api/projects/${projectId}/accounts/${deleteTarget.id}`, {
      method: 'DELETE',
    });
    if (!res.ok) {
      toast.error(
        res.status === 403
          ? t(locale, 'projects.error-admin-required')
          : t(locale, 'projects.error-delete-failed'),
      );
      return;
    }
    deleteDialogOpen = false;
    deleteTarget = null;
    await invalidateAll();
  }

  async function changeRole(id: number, role: 'personal' | 'brand') {
    const res = await fetch(`/api/projects/${projectId}/accounts/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role }),
    });
    if (!res.ok)
      toast.error(
        res.status === 403
          ? t(locale, 'projects.error-admin-required')
          : t(locale, 'projects.error-update-failed'),
      );
    else await invalidateAll();
  }

  async function setDefault(id: number) {
    const res = await fetch(`/api/projects/${projectId}/accounts/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ isDefault: true }),
    });
    if (!res.ok)
      toast.error(
        res.status === 403
          ? t(locale, 'projects.error-admin-required')
          : t(locale, 'projects.error-set-default-failed'),
      );
    else await invalidateAll();
  }
</script>

<div class="space-y-3 max-w-2xl">
  {#each accounts as a (a.id)}
    <div class="border border-border rounded-md p-3 flex items-center gap-3">
      <code class="text-sm">{a.handle}</code>
      <span class="text-xs text-muted-foreground">{platformSlug(a.platformId)}</span>
      {#if a.isDefault}
        <span class="rounded-full ring-1 ring-inset {TONE_CLASS.emerald} px-2 py-0.5 text-[10px] font-medium">
          {t(locale, 'projects.default-badge')}
        </span>
      {:else if isAdmin}
        <Button size="sm" variant="ghost" onclick={() => setDefault(a.id)} class="text-xs">
          {t(locale, 'projects.set-default-button')}
        </Button>
      {/if}
      <SelectField
        value={a.role as 'personal' | 'brand'}
        onValueChange={(v) => changeRole(a.id, v as 'personal' | 'brand')}
        options={ROLE_OPTIONS}
        size="sm"
        class="ml-auto"
        disabled={!isAdmin}
      />
      {#if isAdmin}
        <Button size="sm" variant="ghost" onclick={() => openDeleteDialog(a)}
          >{t(locale, 'projects.delete-button')}</Button
        >
      {/if}
    </div>
  {/each}

  {#if isAdmin}
    {#if addOpen}
      <div class="border border-border rounded-md p-3 space-y-2">
        <label class="flex flex-col gap-1 text-xs">
          {t(locale, 'projects.platform-label')}
          <SelectField
            bind:value={newPlatform}
            options={platforms.map((p) => ({ value: p.slug, label: p.slug }))}
            fullWidth
          />
        </label>
        {#if isMastodon}
          <label class="flex flex-col gap-1 text-xs">
            {t(locale, 'projects.mastodon-instance-url-label')}
            <Input
              bind:value={newInstanceUrl}
              placeholder={t(locale, 'projects.mastodon-instance-url-placeholder')}
            />
          </label>
          <label class="flex flex-col gap-1 text-xs">
            {t(locale, 'projects.mastodon-access-token-label')}
            <Input bind:value={newAccessToken} type="password" />
          </label>
          <p class="text-xs text-muted-foreground">
            {t(locale, 'projects.mastodon-token-hint')}
          </p>
        {:else if isLinkedin}
          <label class="flex flex-col gap-1 text-xs">
            {t(locale, 'projects.linkedin-vanity-slug-label')}
            <Input
              bind:value={newHandle}
              placeholder={t(locale, 'projects.linkedin-vanity-slug-placeholder')}
            />
          </label>
          <label class="flex flex-col gap-1 text-xs">
            {t(locale, 'projects.linkedin-display-name-label')}
            <Input
              bind:value={newDisplayName}
              placeholder={t(locale, 'projects.linkedin-display-name-placeholder')}
            />
          </label>
          <p class="text-xs text-muted-foreground">
            {t(locale, 'projects.linkedin-no-credential-hint')}
          </p>
        {:else}
          <label class="flex flex-col gap-1 text-xs"
            >{t(locale, 'projects.handle-label')}<Input bind:value={newHandle} /></label
          >
        {/if}
        <label class="flex flex-col gap-1 text-xs">
          {t(locale, 'projects.role-label')}
          <SelectField
            value={newRole}
            onValueChange={(v) => (newRole = v as 'personal' | 'brand')}
            options={ROLE_OPTIONS}
            fullWidth
          />
        </label>
        <div class="flex gap-2">
          <Button
            size="sm"
            onclick={add}
            disabled={busy ||
              (isMastodon
                ? !newInstanceUrl.trim() || !newAccessToken.trim()
                : !newHandle.trim())}
          >
            {t(locale, 'projects.add-button')}
          </Button>
          <Button size="sm" variant="ghost" onclick={() => (addOpen = false)}
            >{t(locale, 'projects.cancel-button')}</Button
          >
        </div>
      </div>
    {:else}
      <Button size="sm" variant="outline" onclick={() => (addOpen = true)}
        >{t(locale, 'projects.add-account-button')}</Button
      >
    {/if}
  {/if}
</div>

<DeleteAccountDialog
  bind:open={deleteDialogOpen}
  name={deleteTarget?.handle ?? ''}
  onConfirm={confirmRemove}
  onClose={() => (deleteDialogOpen = false)}
/>
