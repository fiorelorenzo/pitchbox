<script lang="ts">
  import Markdown from '$lib/components/Markdown.svelte';
  import { Button } from '$lib/components/ui/button';
  import { invalidateAll } from '$app/navigation';
  import { toast } from 'svelte-sonner';

  type Insight = {
    id: number;
    summaryMd: string;
    evidence: unknown;
    generatedAt: string;
  };

  let {
    projectId,
    latestInsight,
  }: {
    projectId: number;
    latestInsight: Insight | null;
  } = $props();

  let regenerating = $state(false);

  async function regenerate() {
    regenerating = true;
    try {
      const res = await fetch(`/api/projects/${projectId}/insights`, { method: 'POST' });
      if (res.status === 409) {
        toast.success('Insights are already generating');
        await invalidateAll();
        return;
      }
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
        if (res.status >= 500) {
          console.error('failed to regenerate insights', projectId, res.status, body);
          toast.error('Could not regenerate insights. Please try again.');
        } else {
          toast.error(body.error ?? body.message ?? 'Could not regenerate insights');
        }
        return;
      }
      toast.success('Generating insights (this takes a moment)');
      await invalidateAll();
    } catch {
      toast.error('Could not regenerate insights, check your connection and try again.');
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
