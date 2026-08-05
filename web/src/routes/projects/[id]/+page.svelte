<script lang="ts">
  import { page } from '$app/stores';
  import { toast } from 'svelte-sonner';
  import type { PageData } from './$types';
  import ProjectOverviewTab from '$lib/components/projects/ProjectOverviewTab.svelte';
  import ProjectAccountsTab from '$lib/components/projects/ProjectAccountsTab.svelte';
  import ProjectTemplatesTab from '$lib/components/projects/ProjectTemplatesTab.svelte';
  import ProjectInsightsTab from '$lib/components/projects/ProjectInsightsTab.svelte';
  import PageContainer from '$lib/components/PageContainer.svelte';

  let { data }: { data: PageData } = $props();
  const isAdmin = $derived(data.isAdmin ?? true);
  const tabParam = $page.url.searchParams.get('tab');
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

  // `?run=<id>` (from the Audit log, or a redirect off /campaigns for a
  // project-scoped run) targets one extraction run on the Overview tab:
  // land there so it does not look like the link went nowhere. A
  // non-numeric value is ignored (and reported below) rather than crashing
  // the tab computation - mirrors the campaign detail page (#239, #259).
  const highlightRunId = $derived.by(() => {
    const raw = $page.url.searchParams.get('run');
    if (!raw) return null;
    const n = Number(raw);
    return Number.isInteger(n) && n > 0 ? n : null;
  });
  // A ?run= link must land on the Overview tab, including when it arrives
  // while the page is already mounted. Keying the effect on highlightRunId
  // means clicking another tab afterwards is never overridden: it only
  // re-runs when the deep link itself changes.
  $effect(() => {
    if (highlightRunId != null) tab = 'overview';
  });

  let warnedInvalidRun: string | null = null;
  $effect(() => {
    const raw = $page.url.searchParams.get('run');
    if (raw && highlightRunId == null) {
      if (warnedInvalidRun !== raw) {
        warnedInvalidRun = raw;
        toast.warning('Run link ignored', {
          description: `"${raw}" is not a valid run id - showing the project overview instead.`,
        });
      }
    } else {
      warnedInvalidRun = null;
    }
  });
</script>

<PageContainer size="default">
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
    extractionRunsTotalCount={data.extractionRunsTotalCount}
    extractionRunsNextCursor={data.extractionRunsNextCursor}
    recommendations={data.recommendations}
    {isAdmin}
    {highlightRunId}
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
</PageContainer>
