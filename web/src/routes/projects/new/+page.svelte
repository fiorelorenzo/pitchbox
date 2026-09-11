<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/stores';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { toast } from 'svelte-sonner';
  import PageContainer from '$lib/components/PageContainer.svelte';
  import { t, type Locale } from '$lib/i18n/index.js';

  const locale = $derived($page.data.locale as Locale);

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
        if (res.status === 403) toast.error(t(locale, 'projects.error-admin-required'));
        else if (body.error === 'slug_conflict')
          toast.error(t(locale, 'projects.error-slug-taken', { slug: body.slug ?? slug }));
        else toast.error(body.error ?? t(locale, 'projects.error-create-failed'));
        return;
      }
      toast.success(t(locale, 'projects.toast-created'));
      await goto(`/projects/${body.id}`);
    } finally {
      saving = false;
    }
  }
</script>

<PageContainer size="narrow">
<h1 class="text-2xl font-semibold mb-2">{t(locale, 'projects.new-page-title')}</h1>
<p class="text-sm text-muted-foreground mb-6">
  {t(locale, 'projects.new-page-description')}
</p>

<form
  class="space-y-4 max-w-xl"
  onsubmit={(e) => {
    e.preventDefault();
    submit();
  }}
>
  <label class="flex flex-col gap-1 text-xs">
    {t(locale, 'projects.name-label')}
    <Input bind:value={name} required autofocus />
  </label>
  <label class="flex flex-col gap-1 text-xs">
    <span
      >{t(locale, 'projects.slug-label')}
      <span class="text-muted-foreground">{t(locale, 'projects.slug-hint')}</span></span
    >
    <Input bind:value={slug} oninput={() => (slugTouched = true)} pattern="^[a-z0-9-]+$" />
  </label>

  <div class="flex gap-2 pt-2">
    <Button type="submit" disabled={!name.trim()} loading={saving}
      >{t(locale, 'projects.create-project-button')}</Button
    >
    <a href="/projects"><Button type="button" variant="ghost">{t(locale, 'projects.cancel-button')}</Button></a>
  </div>
</form>
</PageContainer>
