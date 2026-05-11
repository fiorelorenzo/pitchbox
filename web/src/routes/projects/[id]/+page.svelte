<script lang="ts">
  import type { PageData } from './$types';
  import ProjectOverviewTab from '$lib/components/projects/ProjectOverviewTab.svelte';
  import ProjectAccountsTab from '$lib/components/projects/ProjectAccountsTab.svelte';

  let { data }: { data: PageData } = $props();
  let tab = $state<'overview' | 'accounts'>('overview');

  const tabs = [
    { k: 'overview' as const, label: 'Overview' },
    { k: 'accounts' as const, label: 'Accounts' },
  ];
</script>

<div class="flex items-baseline justify-between mb-4">
  <h1 class="text-2xl font-semibold">{data.project.name}</h1>
  <code class="text-sm text-muted-foreground">{data.project.slug}</code>
</div>

<div class="flex gap-2 border-b border-border mb-4">
  {#each tabs as t (t.k)}
    <button
      type="button"
      class={`px-3 py-2 text-sm border-b-2 ${tab === t.k ? 'border-foreground' : 'border-transparent text-muted-foreground'}`}
      onclick={() => (tab = t.k)}
    >
      {t.label}
    </button>
  {/each}
</div>

{#if tab === 'overview'}
  <ProjectOverviewTab
    project={data.project}
    extractionRuns={data.extractionRuns}
    recommendations={data.recommendations}
  />
{:else}
  <ProjectAccountsTab
    projectId={data.project.id}
    accounts={data.accounts}
    platforms={data.platforms}
  />
{/if}
