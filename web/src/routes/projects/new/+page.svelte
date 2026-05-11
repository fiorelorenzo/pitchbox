<script lang="ts">
  import { goto } from '$app/navigation';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { toast } from 'svelte-sonner';

  let name = $state('');
  let slug = $state('');
  let slugTouched = $state(false);
  let saving = $state(false);

  function slugify(s: string): string {
    return s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64);
  }

  $effect(() => {
    if (!slugTouched) slug = slugify(name);
  });

  async function submit() {
    if (saving) return;
    saving = true;
    try {
      const res = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          slug: slug || undefined,
          name,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (body.error === 'slug_conflict') toast.error(`Slug "${body.slug ?? slug}" already taken`);
        else toast.error(body.error ?? 'Failed to create project');
        return;
      }
      toast.success('Project created');
      await goto(`/projects/${body.id}`);
    } finally {
      saving = false;
    }
  }
</script>

<h1 class="text-2xl font-semibold mb-2">New project</h1>
<p class="text-sm text-muted-foreground mb-6">
  Just a name to get started. Description, accounts, and campaign settings can be added from the
  project page.
</p>

<form
  class="space-y-4 max-w-xl"
  onsubmit={(e) => {
    e.preventDefault();
    submit();
  }}
>
  <label class="flex flex-col gap-1 text-xs">
    Name
    <Input bind:value={name} required autofocus />
  </label>
  <label class="flex flex-col gap-1 text-xs">
    <span>Slug <span class="text-muted-foreground">(optional, auto-generated)</span></span>
    <Input bind:value={slug} oninput={() => (slugTouched = true)} pattern="^[a-z0-9-]+$" />
  </label>

  <div class="flex gap-2 pt-2">
    <Button type="submit" disabled={saving || !name.trim()}
      >{saving ? 'Creating…' : 'Create project'}</Button
    >
    <a href="/projects"><Button type="button" variant="ghost">Cancel</Button></a>
  </div>
</form>
