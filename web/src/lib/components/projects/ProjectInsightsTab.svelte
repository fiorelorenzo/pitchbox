<script lang="ts">
  import Markdown from '$lib/components/Markdown.svelte';
  import { Button } from '$lib/components/ui/button';

  type Insight = {
    id: number;
    summaryMd: string;
    evidence: unknown;
    generatedAt: string;
  };

  let {
    projectId: _projectId,
    latestInsight,
  }: {
    projectId: number;
    latestInsight: Insight | null;
  } = $props();

  let regenerating = $state(false);

  async function regenerate() {
    // Stub: the daemon's insights worker (TODO #52) and a future
    // /api/projects/[id]/insights/regenerate endpoint will pick this up.
    regenerating = true;
    try {
      // Placeholder: surface intent without dispatching a run yet.
      await new Promise((r) => setTimeout(r, 300));
      alert('Insights regeneration is not wired yet - daemon worker pending.');
    } finally {
      regenerating = false;
    }
  }
</script>

<div class="space-y-4">
  <div class="flex items-center justify-between">
    <div>
      <h2 class="text-lg font-medium">Project insights</h2>
      <p class="text-sm text-muted-foreground">
        LLM-summarized patterns from this project's outreach history.
      </p>
    </div>
    <Button variant="outline" onclick={regenerate} loading={regenerating}>Regenerate now</Button>
  </div>

  {#if latestInsight}
    <div class="text-xs text-muted-foreground">
      Generated {new Date(latestInsight.generatedAt).toLocaleString()}
    </div>
    <Markdown source={latestInsight.summaryMd} />
  {:else}
    <div class="rounded-md border border-dashed p-6 text-sm text-muted-foreground">
      No insights yet. Once this project has at least 5 drafts and some reply activity, the
      insighter will produce a summary here.
    </div>
  {/if}
</div>
