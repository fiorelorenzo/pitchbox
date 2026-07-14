<script lang="ts">
  import { page } from '$app/state';
  import type { PageData } from './$types';
  import ProjectOverviewTab from '$lib/components/projects/ProjectOverviewTab.svelte';
  import ProjectAccountsTab from '$lib/components/projects/ProjectAccountsTab.svelte';
  import ProjectTemplatesTab from '$lib/components/projects/ProjectTemplatesTab.svelte';
  import ProjectInsightsTab from '$lib/components/projects/ProjectInsightsTab.svelte';

  let { data }: { data: PageData } = $props();
  const isAdmin = $derived(data.isAdmin ?? true);
  const tabParam = page.url.searchParams.get('tab');
  const initialTab =
    tabParam === 'accounts'
      ? 'accounts'
      : tabParam === 'templates'
        ? 'templates'
        : tabParam === 'insights'
          ? 'insights'
          : 'overview';
  let tab = $state<'overview' | 'accounts' | 'templates' | 'insights'>(initialTab);

  const tabs = [
    { k: 'overview' as const, label: 'Overview' },
    { k: 'accounts' as const, label: 'Accounts' },
    { k: 'templates' as const, label: 'Templates' },
    { k: 'insights' as const, label: 'Insights' },
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
    {isAdmin}
  />
{:else if tab === 'accounts'}
  <ProjectAccountsTab
    projectId={data.project.id}
    accounts={data.accounts}
    platforms={data.platforms}
    {isAdmin}
  />
{:else if tab === 'templates'}
  <ProjectTemplatesTab projectId={data.project.id} templates={data.templates} {isAdmin} />
{:else}
  <ProjectInsightsTab projectId={data.project.id} latestInsight={data.latestInsight} />
{/if}
