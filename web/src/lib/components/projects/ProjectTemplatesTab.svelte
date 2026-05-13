<script lang="ts">
  import { invalidateAll } from '$app/navigation';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { SelectField } from '$lib/components/ui/select-field';
  import { toast } from 'svelte-sonner';

  type Template = {
    id: number;
    kind: string;
    title: string;
    body: string;
    isActive: boolean;
    createdAt: string | Date;
  };
  type Props = { projectId: number; templates: Template[] };
  let { projectId, templates }: Props = $props();

  let addOpen = $state(false);
  let newKind = $state<'dm' | 'comment' | 'post'>('comment');
  let newTitle = $state('');
  let newBody = $state('');
  let busy = $state(false);

  const kindOptions = [
    { value: 'dm', label: 'DM' },
    { value: 'comment', label: 'Comment' },
    { value: 'post', label: 'Post' },
  ];

  async function add() {
    if (!newTitle.trim() || !newBody.trim()) {
      toast.error('Title and body are required');
      return;
    }
    busy = true;
    try {
      const res = await fetch(`/api/projects/${projectId}/templates`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: newKind, title: newTitle, body: newBody }),
      });
      if (!res.ok) {
        toast.error('Failed to create template');
        return;
      }
      newTitle = '';
      newBody = '';
      addOpen = false;
      await invalidateAll();
    } finally {
      busy = false;
    }
  }

  async function toggleActive(t: Template) {
    const res = await fetch(`/api/projects/${projectId}/templates/${t.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ isActive: !t.isActive }),
    });
    if (!res.ok) toast.error('Failed to update');
    else await invalidateAll();
  }

  async function remove(t: Template) {
    if (!confirm(`Delete template "${t.title}"?`)) return;
    const res = await fetch(`/api/projects/${projectId}/templates/${t.id}`, {
      method: 'DELETE',
    });
    if (!res.ok) toast.error('Failed to delete');
    else await invalidateAll();
  }
</script>

<div class="flex items-center justify-between mb-4">
  <p class="text-sm text-muted-foreground">
    Few-shot examples grounded in this project's voice. Active templates are surfaced to the agent
    on every run.
  </p>
  <Button onclick={() => (addOpen = !addOpen)}>{addOpen ? 'Cancel' : 'New template'}</Button>
</div>

{#if addOpen}
  <div class="border border-border rounded p-4 mb-4 space-y-3">
    <div class="grid grid-cols-2 gap-3">
      <div>
        <label class="text-sm font-medium block mb-1" for="tpl-kind">Kind</label>
        <SelectField id="tpl-kind" bind:value={newKind} options={kindOptions} fullWidth />
      </div>
      <div>
        <label class="text-sm font-medium block mb-1" for="tpl-title">Title</label>
        <Input id="tpl-title" bind:value={newTitle} placeholder="e.g. Friendly intro" />
      </div>
    </div>
    <div>
      <label class="text-sm font-medium block mb-1" for="tpl-body">Body</label>
      <textarea
        id="tpl-body"
        bind:value={newBody}
        rows="6"
        class="w-full rounded border border-input bg-background px-3 py-2 text-sm"
        placeholder="Example reply or DM body…"
      ></textarea>
    </div>
    <Button onclick={add} disabled={busy}>Save</Button>
  </div>
{/if}

{#if templates.length === 0}
  <p class="text-sm text-muted-foreground">No templates yet.</p>
{:else}
  <div class="space-y-2">
    {#each templates as t (t.id)}
      <div class="border border-border rounded p-3">
        <div class="flex items-center justify-between mb-1">
          <div class="flex items-center gap-2">
            <span class="text-xs uppercase px-2 py-0.5 rounded bg-muted">{t.kind}</span>
            <span class="font-medium">{t.title}</span>
            {#if !t.isActive}
              <span class="text-xs text-muted-foreground">(archived)</span>
            {/if}
          </div>
          <div class="flex gap-2">
            <Button variant="outline" size="sm" onclick={() => toggleActive(t)}>
              {t.isActive ? 'Archive' : 'Restore'}
            </Button>
            <Button variant="outline" size="sm" onclick={() => remove(t)}>Delete</Button>
          </div>
        </div>
        <pre class="text-sm whitespace-pre-wrap text-muted-foreground">{t.body}</pre>
      </div>
    {/each}
  </div>
{/if}
