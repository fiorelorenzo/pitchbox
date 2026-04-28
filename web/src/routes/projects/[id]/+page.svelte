<script lang="ts">
  import type { PageData } from './$types';
  import ProjectOverviewTab from '$lib/components/projects/ProjectOverviewTab.svelte';
  import ProjectConfigsTab from '$lib/components/projects/ProjectConfigsTab.svelte';
  import ProjectAccountsTab from '$lib/components/projects/ProjectAccountsTab.svelte';

  let { data }: { data: PageData } = $props();
  let tab = $state<'overview' | 'configs' | 'accounts'>('overview');

  const tabs = [
    { k: 'overview' as const, label: 'Overview' },
    { k: 'configs' as const, label: 'Configs' },
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
  <ProjectOverviewTab project={data.project} />
{:else if tab === 'configs'}
  <ProjectConfigsTab projectId={data.project.id} configs={data.configs} />
{:else}
  <ProjectAccountsTab
    projectId={data.project.id}
    accounts={data.accounts}
    platforms={data.platforms}
  />
{/if}
