<script lang="ts">
  import { goto, invalidateAll } from '$app/navigation';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { Textarea } from '$lib/components/ui/textarea';
  import { toast } from 'svelte-sonner';
  import DeleteProjectDialog from './DeleteProjectDialog.svelte';

  type Project = {
    id: number;
    slug: string;
    name: string;
    description: string | null;
    defaultAgentRunner: string;
  };
  type Props = { project: Project };
  let { project }: Props = $props();

  // svelte-ignore state_referenced_locally
  let name = $state(project.name);
  // svelte-ignore state_referenced_locally
  let description = $state(project.description ?? '');
  // svelte-ignore state_referenced_locally
  let runner = $state(project.defaultAgentRunner);
  let saving = $state(false);
  let deleteOpen = $state(false);

  async function save() {
    saving = true;
    try {
      const res = await fetch(`/api/projects/${project.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name,
          description: description || null,
          defaultAgentRunner: runner,
        }),
      });
      if (!res.ok) {
        toast.error('Failed to save');
        return;
      }
      toast.success('Saved');
      await invalidateAll();
    } finally {
      saving = false;
    }
  }

  async function remove() {
    const res = await fetch(`/api/projects/${project.id}`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ confirmSlug: project.slug }),
    });
    if (!res.ok) {
      toast.error('Failed to delete');
      return;
    }
    toast.success('Project deleted');
    await goto('/projects');
  }
</script>

<div class="space-y-6 max-w-xl">
  <label class="flex flex-col gap-1 text-xs">
    Slug
    <Input value={project.slug} disabled />
    <span class="text-xs text-muted-foreground">Slug cannot be changed.</span>
  </label>
  <label class="flex flex-col gap-1 text-xs">
    Name
    <Input bind:value={name} />
  </label>
  <label class="flex flex-col gap-1 text-xs">
    Description
    <Textarea bind:value={description} rows={2} />
  </label>
  <label class="flex flex-col gap-1 text-xs">
    Default agent runner
    <Input bind:value={runner} />
  </label>
  <div class="flex justify-between items-center pt-2">
    <Button onclick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</Button>
    <Button variant="destructive" onclick={() => (deleteOpen = true)}>Delete project</Button>
  </div>
</div>

<DeleteProjectDialog
  bind:open={deleteOpen}
  slug={project.slug}
  onConfirm={remove}
  onClose={() => (deleteOpen = false)}
/>
