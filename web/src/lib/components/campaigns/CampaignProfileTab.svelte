<script lang="ts">
  import { invalidateAll } from '$app/navigation';
  import { onMount, onDestroy } from 'svelte';
  import { Button } from '$lib/components/ui/button';
  import { toast } from 'svelte-sonner';
  import { getSchema, type ScenarioSlug } from '@pitchbox/shared/campaigns';

  import RegenerateProfileDialog from './RegenerateProfileDialog.svelte';
  import RedditScoutTargetingForm from './forms/RedditScoutTargetingForm.svelte';
  import RedditScoutVoiceForm from './forms/RedditScoutVoiceForm.svelte';
  import RedditScoutOfferForm from './forms/RedditScoutOfferForm.svelte';
  import RedditCommenterTargetingForm from './forms/RedditCommenterTargetingForm.svelte';
  import RedditCommenterVoiceForm from './forms/RedditCommenterVoiceForm.svelte';
  import RedditCommenterValueForm from './forms/RedditCommenterValueForm.svelte';
  import RedditPosterAngleForm from './forms/RedditPosterAngleForm.svelte';
  import SystemInstructionsForm from './forms/SystemInstructionsForm.svelte';

  type SkillRun = { id: number; status: string; params: { objective?: string } | null };

  type Props = {
    campaignId: number;
    scenarioSlug: ScenarioSlug;
    initialConfig: Record<string, unknown>;
    skillRuns: SkillRun[];
  };
  let { campaignId, scenarioSlug, initialConfig, skillRuns }: Props = $props();

  // svelte-ignore state_referenced_locally
  let config = $state<Record<string, unknown>>(structuredClone(initialConfig));
  let saving = $state(false);
  let regenOpen = $state(false);
  // svelte-ignore state_referenced_locally
  let runningRunId = $state<number | null>(
    skillRuns.find((r) => r.status === 'running')?.id ?? null,
  );
  const generationRunning = $derived(runningRunId !== null);
  const lastObjective = $derived(skillRuns[0]?.params?.objective ?? '');

  function patch(p: Record<string, unknown>) {
    config = { ...config, ...p };
  }

  async function save() {
    if (saving) return;
    saving = true;
    try {
      // Scenarios without a registered structured schema (e.g. mastodon-*)
      // don't have a form here yet, so save the config as-is instead of
      // crashing on a missing schema.
      const scenarioSchema = getSchema(scenarioSlug);
      let configToSave: Record<string, unknown> = config;
      if (scenarioSchema) {
        const validated = scenarioSchema.safeParse(config);
        if (!validated.success) {
          toast.error('Profile is invalid - fix the highlighted fields');
          return;
        }
        configToSave = validated.data;
      }
      const res = await fetch(`/api/campaigns/${campaignId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ config: configToSave }),
      });
      const body = await res.json();
      if (!res.ok) {
        toast.error(body.error ?? 'Save failed');
        return;
      }
      toast.success('Profile saved');
      await invalidateAll();
    } finally {
      saving = false;
    }
  }

  let es: EventSource | null = null;
  onMount(() => {
    es = new EventSource('/api/stream');
    es.addEventListener('run:finished', async (ev: MessageEvent) => {
      let payload: { campaignId?: number | null; runId?: number } = {};
      try {
        payload = JSON.parse(ev.data);
      } catch {
        /* ignore */
      }
      if (payload.campaignId !== campaignId) return;
      if (runningRunId !== null && payload.runId === runningRunId) {
        runningRunId = null;
        await invalidateAll();
        toast.success('Profile generated');
      }
    });
  });
  onDestroy(() => es?.close());
</script>

<div class="space-y-6">
  {#if generationRunning}
    <div
      class="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300"
    >
      Generation running - profile is locked until it finishes.
    </div>
  {/if}

  <div class="flex justify-between items-center">
    <h2 class="text-lg font-semibold">Profile</h2>
    <Button variant="outline" onclick={() => (regenOpen = true)} disabled={generationRunning}>
      Regenerate
    </Button>
  </div>

  {#if scenarioSlug === 'reddit-scout'}
    <RedditScoutTargetingForm
      value={{
        targetSubreddits: (config.targetSubreddits as string[]) ?? [],
        topicKeywords: (config.topicKeywords as string[]) ?? [],
        avoidKeywords: (config.avoidKeywords as string[]) ?? [],
        fitScoreThreshold: (config.fitScoreThreshold as number) ?? 3,
      }}
      onChange={(v) => patch(v)}
      disabled={generationRunning}
    />
    <RedditScoutVoiceForm
      value={(config.voice as never) ?? {
        tone: 'casual',
        hardBans: [],
        dos: [],
        openerStyle: 'lowercase-casual',
        disclosure: '',
      }}
      onChange={(v) => patch({ voice: v })}
      disabled={generationRunning}
    />
    <RedditScoutOfferForm
      value={(config.offer as never) ?? { productUrl: '', subject: '', text: '' }}
      onChange={(v) => patch({ offer: v })}
      disabled={generationRunning}
    />
  {:else if scenarioSlug === 'reddit-commenter'}
    <RedditCommenterTargetingForm
      value={{
        targetSubreddits: (config.targetSubreddits as string[]) ?? [],
        topicKeywords: (config.topicKeywords as string[]) ?? [],
        avoidKeywords: (config.avoidKeywords as string[]) ?? [],
      }}
      onChange={(v) => patch(v)}
      disabled={generationRunning}
    />
    <RedditCommenterVoiceForm
      value={(config.voice as never) ?? {
        tone: 'casual',
        hardBans: [],
        dos: [],
        disclosure: '',
      }}
      onChange={(v) => patch({ voice: v })}
      disabled={generationRunning}
    />
    <RedditCommenterValueForm
      value={{
        valuePropositions: (config.valuePropositions as string[]) ?? [],
        productUrl: (config.productUrl as string) ?? '',
      }}
      onChange={(v) => patch(v)}
      disabled={generationRunning}
    />
  {:else if scenarioSlug === 'reddit-poster'}
    <RedditCommenterTargetingForm
      value={{
        targetSubreddits: (config.targetSubreddits as string[]) ?? [],
        topicKeywords: (config.topicKeywords as string[]) ?? [],
        avoidKeywords: (config.avoidKeywords as string[]) ?? [],
      }}
      onChange={(v) => patch(v)}
      disabled={generationRunning}
    />
    <RedditPosterAngleForm
      value={(config.postAngle as string) ?? ''}
      onChange={(v) => patch({ postAngle: v })}
      disabled={generationRunning}
    />
    <RedditCommenterVoiceForm
      value={(config.voice as never) ?? {
        tone: 'casual',
        hardBans: [],
        dos: [],
        disclosure: '',
      }}
      onChange={(v) => patch({ voice: v })}
      disabled={generationRunning}
    />
    <RedditCommenterValueForm
      value={{
        valuePropositions: (config.valuePropositions as string[]) ?? [],
        productUrl: (config.productUrl as string) ?? '',
      }}
      onChange={(v) => patch(v)}
      disabled={generationRunning}
    />
  {/if}

  <SystemInstructionsForm
    value={(config.systemInstructions as string) ?? ''}
    onChange={(v) => patch({ systemInstructions: v })}
    disabled={generationRunning}
  />

  <div class="pt-2 border-t flex justify-end">
    <Button onclick={save} disabled={generationRunning} loading={saving}>Save</Button>
  </div>
</div>

<RegenerateProfileDialog
  open={regenOpen}
  onOpenChange={(v) => (regenOpen = v)}
  {campaignId}
  initialObjective={lastObjective}
  onLaunched={(runId) => {
    runningRunId = runId;
    invalidateAll();
  }}
/>
