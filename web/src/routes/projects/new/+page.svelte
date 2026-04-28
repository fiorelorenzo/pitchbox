<script lang="ts">
  import { goto } from '$app/navigation';
  import type { PageData } from './$types';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { Textarea } from '$lib/components/ui/textarea';
  import TagListInput from '$lib/components/projects/TagListInput.svelte';
  import { SelectField } from '$lib/components/ui/select-field';
  import { toast } from 'svelte-sonner';

  let { data }: { data: PageData } = $props();

  let name = $state('');
  let slug = $state('');
  let slugTouched = $state(false);
  let description = $state('');
  let pitch = $state('');
  let disclosure = $state('');
  let topics = $state<string[]>([]);
  let handle = $state('');
  let role = $state<'personal' | 'brand'>('personal');
  // svelte-ignore state_referenced_locally
  let platformSlug = $state(data.platforms[0]?.slug ?? 'reddit');
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
          slug,
          name,
          description: description || undefined,
          configs: [
            { key: 'product.pitch', value: { text: pitch } },
            { key: 'voice.dm_rules', value: { hardBans: [], dos: [], disclosure, examples: [] } },
            { key: 'topicAngles', value: topics },
          ],
          account: { handle, role, platformSlug },
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (body.error === 'slug_conflict') toast.error(`Slug "${slug}" already taken`);
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

<h1 class="text-2xl font-semibold mb-6">New project</h1>

<form
  class="space-y-6 max-w-xl"
  onsubmit={(e) => {
    e.preventDefault();
    submit();
  }}
>
  <section class="space-y-3">
    <h2 class="font-medium">Basics</h2>
    <label class="flex flex-col gap-1 text-xs">
      Name
      <Input bind:value={name} required />
    </label>
    <label class="flex flex-col gap-1 text-xs">
      Slug
      <Input bind:value={slug} oninput={() => (slugTouched = true)} pattern="^[a-z0-9-]+$" required />
    </label>
    <label class="flex flex-col gap-1 text-xs">
      Description
      <Textarea bind:value={description} rows={2} />
    </label>
  </section>

  <section class="space-y-3">
    <h2 class="font-medium">Voice & product</h2>
    <label class="flex flex-col gap-1 text-xs">
      Product pitch
      <Textarea bind:value={pitch} required rows={3} />
    </label>
    <label class="flex flex-col gap-1 text-xs">
      DM disclosure line
      <Textarea bind:value={disclosure} rows={2} />
    </label>
    <label class="flex flex-col gap-1 text-xs">
      Topic angles
      <TagListInput bind:value={topics} placeholder="Add a topic and press Enter" />
    </label>
  </section>

  <section class="space-y-3">
    <h2 class="font-medium">Initial account</h2>
    <label class="flex flex-col gap-1 text-xs">
      Handle
      <Input bind:value={handle} required />
    </label>
    <label class="flex flex-col gap-1 text-xs">
      Role
      <SelectField
        value={role}
        onValueChange={(v) => (role = v as 'personal' | 'brand')}
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
        bind:value={platformSlug}
        options={data.platforms.map((p) => ({ value: p.slug, label: p.slug }))}
        fullWidth
      />
    </label>
  </section>

  <div class="flex gap-2">
    <Button type="submit" disabled={saving}>{saving ? 'Creating…' : 'Create project'}</Button>
    <a href="/projects"><Button type="button" variant="ghost">Cancel</Button></a>
  </div>
</form>
