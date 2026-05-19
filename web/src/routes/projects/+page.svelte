<script lang="ts">
  import type { PageData } from './$types';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import ProjectCard from '$lib/components/projects/ProjectCard.svelte';
  import EmptyState from '$lib/components/EmptyState.svelte';
  import { Button } from '$lib/components/ui/button';
  import { FolderKanban } from 'lucide-svelte';

  let { data }: { data: PageData } = $props();
</script>

<PageHeader title="Projects">
  {#snippet actions()}
    <a href="/projects/new"><Button size="sm">New project</Button></a>
  {/snippet}
</PageHeader>

{#if data.projects.length === 0}
  <EmptyState
    icon={FolderKanban}
    title="No projects yet"
    description="A project groups the accounts, campaigns and contact history for one product or brand. Create the first one to start drafting outreach."
    size="lg"
  >
    <a href="/projects/new"><Button size="sm">Create project</Button></a>
  </EmptyState>
{:else}
  <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
    {#each data.projects as p (p.id)}
      <ProjectCard project={p} />
    {/each}
  </div>
{/if}
