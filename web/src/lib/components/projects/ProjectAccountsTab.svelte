<script lang="ts">
  import { invalidateAll } from '$app/navigation';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { SelectField } from '$lib/components/ui/select-field';
  import { toast } from 'svelte-sonner';

  type Account = { id: number; handle: string; role: string; platformId: number };
  type Platform = { id: number; slug: string };
  type Props = { projectId: number; accounts: Account[]; platforms: Platform[] };
  let { projectId, accounts, platforms }: Props = $props();

  let addOpen = $state(false);
  let newHandle = $state('');
  let newRole = $state<'personal' | 'brand'>('personal');
  // svelte-ignore state_referenced_locally
  let newPlatform = $state(platforms[0]?.slug ?? 'reddit');
  let busy = $state(false);

  function platformSlug(id: number) {
    return platforms.find((p) => p.id === id)?.slug ?? `#${id}`;
  }

  async function add() {
    busy = true;
    try {
      const res = await fetch(`/api/projects/${projectId}/accounts`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ handle: newHandle, role: newRole, platformSlug: newPlatform }),
      });
      if (!res.ok) {
        toast.error('Failed to add account');
        return;
      }
      newHandle = '';
      addOpen = false;
      await invalidateAll();
    } finally {
      busy = false;
    }
  }

  async function remove(id: number) {
    if (!confirm('Delete account?')) return;
    const res = await fetch(`/api/projects/${projectId}/accounts/${id}`, { method: 'DELETE' });
    if (!res.ok) toast.error('Failed to delete');
    else await invalidateAll();
  }

  async function changeRole(id: number, role: 'personal' | 'brand') {
    const res = await fetch(`/api/projects/${projectId}/accounts/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role }),
    });
    if (!res.ok) toast.error('Failed to update');
    else await invalidateAll();
  }
</script>

<div class="space-y-3 max-w-2xl">
  {#each accounts as a (a.id)}
    <div class="border border-border rounded-md p-3 flex items-center gap-3">
      <code class="text-sm">{a.handle}</code>
      <span class="text-xs text-muted-foreground">{platformSlug(a.platformId)}</span>
      <SelectField
        value={a.role as 'personal' | 'brand'}
        onValueChange={(v) => changeRole(a.id, v as 'personal' | 'brand')}
        options={[
          { value: 'personal', label: 'personal' },
          { value: 'brand', label: 'brand' },
        ]}
        size="sm"
        class="ml-auto"
      />
      <Button size="sm" variant="ghost" onclick={() => remove(a.id)}>Delete</Button>
    </div>
  {/each}

  {#if addOpen}
    <div class="border border-border rounded-md p-3 space-y-2">
      <label class="flex flex-col gap-1 text-xs">Handle<Input bind:value={newHandle} /></label>
      <label class="flex flex-col gap-1 text-xs">
        Role
        <SelectField
          value={newRole}
          onValueChange={(v) => (newRole = v as 'personal' | 'brand')}
          options={[
            { value: 'personal', label: 'personal' },
            { value: 'brand', label: 'brand' },
          ]}
          fullWidth
        />
      </label>
      <label class="flex flex-col gap-1 text-xs">
        Platform
        <SelectField
          bind:value={newPlatform}
          options={platforms.map((p) => ({ value: p.slug, label: p.slug }))}
          fullWidth
        />
      </label>
      <div class="flex gap-2">
        <Button size="sm" onclick={add} disabled={busy || !newHandle.trim()}>Add</Button>
        <Button size="sm" variant="ghost" onclick={() => (addOpen = false)}>Cancel</Button>
      </div>
    </div>
  {:else}
    <Button size="sm" variant="outline" onclick={() => (addOpen = true)}>Add account</Button>
  {/if}
</div>
