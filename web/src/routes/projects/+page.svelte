<script lang="ts">
  import { page } from '$app/stores';
  import type { PageData } from './$types';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import ProjectCard from '$lib/components/projects/ProjectCard.svelte';
  import EmptyState from '$lib/components/EmptyState.svelte';
  import { Button } from '$lib/components/ui/button';
  import { FolderKanban } from '@lucide/svelte';
  import PageContainer from '$lib/components/PageContainer.svelte';
  import { t, type Locale } from '$lib/i18n/index.js';

  let { data }: { data: PageData } = $props();
  const isAdmin = $derived(data.isAdmin ?? true);
  const locale = $derived($page.data.locale as Locale);
</script>

<PageContainer size="default">
<PageHeader title={t(locale, 'nav.projects')}>
  {#snippet actions()}
    {#if isAdmin}
      <a href="/projects/new"><Button size="sm">{t(locale, 'projects.new-project-button')}</Button></a>
    {/if}
  {/snippet}
</PageHeader>

{#if data.projects.length === 0}
  <EmptyState
    icon={FolderKanban}
    title={t(locale, 'projects.empty-title')}
    description={t(locale, 'projects.empty-body')}
    size="lg"
  >
    {#if isAdmin}
      <a href="/projects/new"><Button size="sm">{t(locale, 'projects.create-project-button')}</Button></a>
    {/if}
  </EmptyState>
{:else}
  <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
    {#each data.projects as p (p.id)}
      <ProjectCard project={p} />
    {/each}
  </div>
{/if}
</PageContainer>
