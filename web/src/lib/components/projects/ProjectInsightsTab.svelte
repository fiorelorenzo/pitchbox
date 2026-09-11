<script lang="ts">
  import { page } from '$app/stores';
  import Markdown from '$lib/components/Markdown.svelte';
  import { Button } from '$lib/components/ui/button';
  import { invalidateAll } from '$app/navigation';
  import { toast } from 'svelte-sonner';
  import { t, type Locale } from '$lib/i18n/index.js';

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

  const locale = $derived($page.data.locale as Locale);

  let regenerating = $state(false);

  async function regenerate() {
    regenerating = true;
    try {
      const res = await fetch(`/api/projects/${projectId}/insights`, { method: 'POST' });
      if (res.status === 409) {
        toast.success(t(locale, 'projects.toast-insights-already-generating'));
        await invalidateAll();
        return;
      }
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
        if (res.status >= 500) {
          console.error('failed to regenerate insights', projectId, res.status, body);
          toast.error(t(locale, 'projects.error-insights-regenerate-failed'));
        } else {
          toast.error(body.error ?? body.message ?? t(locale, 'projects.error-insights-regenerate'));
        }
        return;
      }
      toast.success(t(locale, 'projects.toast-insights-generating'));
      await invalidateAll();
    } catch {
      toast.error(t(locale, 'projects.error-insights-regenerate-offline'));
    } finally {
      regenerating = false;
    }
  }
</script>

<div class="space-y-4">
  <div class="flex items-center justify-between">
    <div>
      <h2 class="text-lg font-medium">{t(locale, 'projects.insights-title')}</h2>
      <p class="text-sm text-muted-foreground">
        {t(locale, 'projects.insights-description')}
      </p>
    </div>
    <Button variant="outline" onclick={regenerate} loading={regenerating}
      >{t(locale, 'projects.regenerate-now-button')}</Button
    >
  </div>

  {#if latestInsight}
    <div class="text-xs text-muted-foreground">
      {t(locale, 'projects.insights-generated-at', {
        when: new Date(latestInsight.generatedAt).toLocaleString(),
      })}
    </div>
    <Markdown source={latestInsight.summaryMd} />
  {:else}
    <div class="rounded-md border border-dashed p-6 text-sm text-muted-foreground">
      {t(locale, 'projects.insights-empty')}
    </div>
  {/if}
</div>
