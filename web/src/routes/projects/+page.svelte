<script lang="ts">
  import type { PageData } from './$types';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import ProjectCard from '$lib/components/projects/ProjectCard.svelte';
  import { Button } from '$lib/components/ui/button';

  let { data }: { data: PageData } = $props();
</script>

<PageHeader title="Projects">
  {#snippet actions()}
    <a href="/projects/new"><Button size="sm">New project</Button></a>
  {/snippet}
</PageHeader>

{#if data.projects.length === 0}
  <p class="text-sm text-muted-foreground">No projects yet. Create one to get started.</p>
{:else}
  <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
    {#each data.projects as p (p.id)}
      <ProjectCard project={p} />
    {/each}
  </div>
{/if}
