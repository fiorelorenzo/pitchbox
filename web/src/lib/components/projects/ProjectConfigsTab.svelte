<script lang="ts">
  import { invalidateAll } from '$app/navigation';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { toast } from 'svelte-sonner';
  import ConfigKeyForm from './ConfigKeyForm.svelte';

  type Config = { key: string; value: unknown; version: number };
  type Props = { projectId: number; configs: Config[] };
  let { projectId, configs }: Props = $props();

  let editing = $state<Record<string, { value: unknown; raw: boolean }>>({});
  let savingKey = $state<string | null>(null);
  let newKeyName = $state('');
  let newKeyValue = $state<unknown>(null);
  let newKeyShown = $state(false);

  function startEdit(c: Config) {
    editing = { ...editing, [c.key]: { value: c.value, raw: false } };
  }

  function cancelEdit(key: string) {
    const next = { ...editing };
    delete next[key];
    editing = next;
  }

  async function save(c: Config) {
    const e = editing[c.key];
    if (!e) return;
    savingKey = c.key;
    try {
      const res = await fetch(
        `/api/projects/${projectId}/configs/${encodeURIComponent(c.key)}`,
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ value: e.value, expectedPreviousVersion: c.version }),
        },
      );
      const body = await res.json().catch(() => ({}));
      if (res.status === 409) {
        toast.error('Config changed elsewhere, reload the page');
        return;
      }
      if (!res.ok) {
        toast.error(body.error ?? 'Failed to save');
        return;
      }
      toast.success('Saved');
      cancelEdit(c.key);
      await invalidateAll();
    } finally {
      savingKey = null;
    }
  }

  async function addKey() {
    if (!newKeyName.trim()) return;
    savingKey = newKeyName;
    try {
      const res = await fetch(`/api/projects/${projectId}/configs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key: newKeyName.trim(), value: newKeyValue }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(body.error ?? 'Failed to add key');
        return;
      }
      toast.success('Key added');
      newKeyName = '';
      newKeyValue = null;
      newKeyShown = false;
      await invalidateAll();
    } finally {
      savingKey = null;
    }
  }

  async function deleteKey(key: string) {
    if (!confirm(`Delete config key "${key}"?`)) return;
    const res = await fetch(
      `/api/projects/${projectId}/configs/${encodeURIComponent(key)}`,
      { method: 'DELETE' },
    );
    if (!res.ok) {
      toast.error('Failed to delete');
      return;
    }
    toast.success('Key deleted');
    await invalidateAll();
  }

  function toggleRaw(key: string) {
    const e = editing[key];
    if (!e) return;
    editing = { ...editing, [key]: { ...e, raw: !e.raw } };
  }
</script>

<div class="space-y-4 max-w-2xl">
  {#each configs as c (c.key)}
    {@const e = editing[c.key]}
    <div class="border border-border rounded-md p-4">
      <div class="flex items-center justify-between mb-2">
        <code class="text-sm font-medium">{c.key}</code>
        <div class="text-xs text-muted-foreground flex gap-2 items-center">
          <span>v{c.version}</span>
          {#if !e}
            <button class="hover:underline" onclick={() => startEdit(c)}>Edit</button>
            <button class="text-destructive hover:underline" onclick={() => deleteKey(c.key)}>Delete</button>
          {:else}
            <button class="hover:underline" onclick={() => toggleRaw(c.key)}>
              {e.raw ? 'Use form' : 'Edit as JSON'}
            </button>
          {/if}
        </div>
      </div>
      {#if e}
        <ConfigKeyForm
          keyName={c.key}
          value={e.value}
          forceRaw={e.raw}
          onChange={(v) => (editing = { ...editing, [c.key]: { ...e, value: v } })}
        />
        <div class="flex gap-2 mt-3">
          <Button size="sm" onclick={() => save(c)} disabled={savingKey === c.key}>
            {savingKey === c.key ? 'Saving…' : 'Save'}
          </Button>
          <Button size="sm" variant="ghost" onclick={() => cancelEdit(c.key)}>Cancel</Button>
        </div>
      {:else}
        <pre class="text-xs bg-muted/50 rounded p-2 overflow-x-auto">{JSON.stringify(c.value, null, 2)}</pre>
      {/if}
    </div>
  {/each}

  {#if newKeyShown}
    <div class="border border-border rounded-md p-4 space-y-3">
      <label class="flex flex-col gap-1 text-xs">
        Key
        <Input bind:value={newKeyName} placeholder="e.g. custom.something" />
      </label>
      <ConfigKeyForm
        keyName={newKeyName}
        value={newKeyValue}
        forceRaw={!newKeyName}
        onChange={(v) => (newKeyValue = v)}
      />
      <div class="flex gap-2">
        <Button size="sm" onclick={addKey} disabled={!newKeyName.trim()}>Add key</Button>
        <Button size="sm" variant="ghost" onclick={() => (newKeyShown = false)}>Cancel</Button>
      </div>
    </div>
  {:else}
    <Button size="sm" variant="outline" onclick={() => (newKeyShown = true)}>Add config key</Button>
  {/if}
</div>
