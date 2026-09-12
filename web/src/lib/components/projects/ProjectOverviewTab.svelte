<script lang="ts">
  import { goto, invalidateAll } from '$app/navigation';
  import { page } from '$app/stores';
  import { onMount, onDestroy, tick } from 'svelte';
  import { Button } from '$lib/components/ui/button';
  import Spinner from '$lib/components/Spinner.svelte';
  import { Input } from '$lib/components/ui/input';
  import { SelectField } from '$lib/components/ui/select-field';
  import { toast } from 'svelte-sonner';
  import DeleteProjectDialog from './DeleteProjectDialog.svelte';
  import Markdown from '$lib/components/Markdown.svelte';
  import ProjectSourcesPanel from './ProjectSourcesPanel.svelte';
  import DescriptionDiffModal from './DescriptionDiffModal.svelte';
  import ProjectExtractionRunsTable from './ProjectExtractionRunsTable.svelte';
  import CampaignRecommendationsList, {
    type Recommendation,
  } from './CampaignRecommendationsList.svelte';
  import { DESCRIPTION_SCAFFOLD } from '@pitchbox/shared/project-extraction';
  import { TONE_BANNER_CLASS, TONE_TEXT_CLASS } from '$lib/config/status-badges';
  import {
    ASSIST_TONES,
    ASSIST_TONE_NOTES_MAX,
    isAssistTone,
    type AssistTone,
  } from '@pitchbox/shared/assist/tone';
  import StreamStatusBanner from '$lib/realtime/StreamStatusBanner.svelte';
  import { getSseManager } from '$lib/realtime/sse';
  import { t, type Locale } from '$lib/i18n/index.js';

  /** Fallback poll while a description run is in flight (see the effect
   * below). Capped at 20 minutes' worth of ticks so an orphaned `running`
   * row cannot keep a tab requesting forever. */
  const POLL_INTERVAL_MS = 10_000;
  const POLL_MAX_TICKS = 120;

  type RunnerMeta = { slug: string; label: string; implemented: boolean };

  type Project = {
    id: number;
    slug: string;
    name: string;
    description: string | null;
    defaultAgentRunner: string;
    /** Per-project voice override (#408). Both null means "inherit the
     * organization's linkedin_assist tone" - see resolveEffectiveVoice in
     * shared/src/linkedin-assist.ts. */
    voiceTone: string | null;
    voiceToneNotes: string | null;
  };
  type ExtractionRun = {
    id: number;
    status: string;
    trigger: string;
    agentRunner: string;
    startedAt: string;
    finishedAt: string | null;
    durationMs: number | null;
    tokensUsed: number | null;
    error: string | null;
    /** The source ids the run was started over. `source` is the old
     * one-source-per-run shape, still on historical rows. */
    params: { sourceIds?: number[]; source?: { kind: string; value: string } } | null;
  };
  type ProjectSource = import('./ProjectSourcesPanel.svelte').ProjectSource;

  type Props = {
    project: Project;
    extractionRuns: ExtractionRun[];
    extractionRunsTotalCount: number;
    extractionRunsNextCursor: { startedAt: string; id: string } | null;
    recommendations: Recommendation[];
    isAdmin: boolean;
    highlightRunId?: number | null;
    runners: RunnerMeta[];
    sources: ProjectSource[];
  };
  let {
    project,
    extractionRuns,
    extractionRunsTotalCount,
    extractionRunsNextCursor,
    recommendations,
    isAdmin,
    highlightRunId = null,
    runners,
    sources,
  }: Props = $props();

  const locale = $derived($page.data.locale as Locale);

  // `runners` is already filtered to this deployment's edition (#410) - the
  // list an admin can pick from. The project's own snapshot might predate
  // that guard (or a since-changed edition), so it stays visible here as a
  // disabled option rather than the select silently rendering blank for a
  // real, persisted value.
  const RUNNER_OPTIONS = $derived.by(() => {
    const opts = runners.map((m) => ({
      value: m.slug,
      label: m.implemented
        ? m.label
        : t(locale, 'projects.runner-label-unavailable', { label: m.label }),
      disabled: !m.implemented,
    }));
    if (!opts.some((o) => o.value === project.defaultAgentRunner)) {
      opts.push({
        value: project.defaultAgentRunner,
        label: t(locale, 'projects.runner-label-unavailable-edition', {
          label: project.defaultAgentRunner,
        }),
        disabled: true,
      });
    }
    return opts;
  });

  // svelte-ignore state_referenced_locally
  let name = $state(project.name);
  // The operator's unsaved text, or null for "no local edit, follow the
  // server". Null is what lets a finished run land on screen; a non-null
  // draft is what survives leaving the editor (Preview) and being saved.
  let draft = $state<string | null>(null);
  // svelte-ignore state_referenced_locally
  let runner = $state(project.defaultAgentRunner);
  // 'inherit' means both DB columns are null: this project falls back to the
  // organization's linkedin_assist tone (#408). An unrecognised stored value
  // (a stale column from an older build) is treated the same as unset,
  // mirroring resolveEffectiveVoice's own fallback.
  // svelte-ignore state_referenced_locally
  let voiceTone = $state<AssistTone | 'inherit'>(
    isAssistTone(project.voiceTone) ? project.voiceTone : 'inherit',
  );
  // svelte-ignore state_referenced_locally
  let voiceToneNotes = $state(project.voiceToneNotes ?? '');
  const VOICE_TONE_LABELS = $derived<Record<AssistTone, string>>({
    'match-room': t(locale, 'projects.voice-tone.match-room'),
    professional: t(locale, 'projects.voice-tone.professional'),
    plain: t(locale, 'projects.voice-tone.plain'),
    warm: t(locale, 'projects.voice-tone.warm'),
    technical: t(locale, 'projects.voice-tone.technical'),
    custom: t(locale, 'projects.voice-tone.custom'),
  });
  const VOICE_OPTIONS = $derived<Array<{ value: AssistTone | 'inherit'; label: string }>>([
    { value: 'inherit', label: t(locale, 'projects.voice-tone.inherit') },
    ...ASSIST_TONES.map((tone) => ({ value: tone, label: VOICE_TONE_LABELS[tone] })),
  ]);
  let saving = $state(false);
  let startingRun = $state(false);
  let deleteOpen = $state(false);
  let sourcesPanelEl = $state<HTMLDivElement | null>(null);
  // Gates loading the bytemd editor stack: only fetched once the user
  // actually starts editing, keeping the read path free of it.
  let editingDescription = $state(false);

  let diffOpen = $state(false);
  let runningRunId = $state<number | null>(null);
  let descriptionAtLaunch = $state<string>('');
  let descriptionBeforeUpdate = $state<string>('');
  // svelte-ignore state_referenced_locally
  let extractionRunsState = $state(extractionRuns);

  let extractionRunning = $derived(
    runningRunId !== null || extractionRunsState.some((r) => r.status === 'running'),
  );

  // What the band shows: the operator's draft if there is one, otherwise
  // whatever the server last said. The mode (`editingDescription`) chooses
  // the editor or a rendered view, never the text - making the mode the
  // discriminator is what broke Preview, which leaves edit mode precisely in
  // order to render the draft.
  //
  // `description` used to be a local `$state` synced by an effect that only
  // wrote when the local copy was empty, so a project that already had a
  // description kept showing the old text until the page was reloaded: the
  // SSE description:updated event was the only thing that ever wrote it, and
  // that event is lost for good if the stream was reconnecting (a run takes
  // minutes) or the tab was opened mid-run.
  const shownDescription = $derived(draft ?? project.description ?? '');

  function startEditing() {
    // Seed from the server only when there is nothing local yet: re-entering
    // the editor must never overwrite text the operator already typed.
    draft ??= project.description ?? '';
    editingDescription = true;
  }

  // Only an active source is read by a run, so the action's availability
  // follows the same count the server checks in `runProjectExtraction`.
  const activeSourceCount = $derived(sources.filter((s) => s.active).length);

  // Keep the runs table reactive to upstream prop changes (post-invalidate).
  $effect(() => {
    extractionRunsState = extractionRuns;
  });

  // A run takes minutes and both events that end it (project:description:updated
  // and run:finished) arrive over one SSE stream with no replay, so a
  // reconnect inside that window drops them for good and the page keeps
  // showing a spinner over the old description until someone reloads by
  // hand. While a run is in flight, poll the cheap runs endpoint and reload
  // the page data as soon as it is no longer running; the SSE path still
  // wins when it works, since it also carries the diff toast.
  //
  // Bounded and serialised on purpose: a crashed dispatch can leave a
  // `running` row behind with nothing to sweep it (unlike
  // `runProjectInsights`' STALE_MS), and an unbounded 10s loop against a row
  // that will never change is a worse bug than the stuck spinner it was
  // meant to fix. A tick that throws is swallowed - the next one retries,
  // and the conditions this exists for (a restarting server, a dropped
  // connection) are exactly the ones that make `fetch` reject.
  $effect(() => {
    if (!extractionRunning) return;
    let inFlight = false;
    let ticks = 0;
    const timer = setInterval(async () => {
      if (inFlight) return;
      if (typeof document !== 'undefined' && document.hidden) return;
      if (++ticks > POLL_MAX_TICKS) {
        clearInterval(timer);
        return;
      }
      inFlight = true;
      try {
        const res = await fetch(`/api/projects/${project.id}/runs?limit=5`);
        if (!res.ok) return;
        const body = (await res.json()) as { runs?: Array<{ status: string }> };
        if (!body?.runs) return;
        if (body.runs.some((r) => r.status === 'running')) return;
        runningRunId = null;
        await invalidateAll();
        extractionRunsState = extractionRuns;
      } catch {
        /* the next tick retries */
      } finally {
        inFlight = false;
      }
    }, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  });

  /**
   * Starts the description run over the whole active source set. The
   * endpoint takes no body: it resolves the set itself, so this cannot
   * disagree with what the agent will read. It lives here, next to the
   * description it rewrites, rather than in the sources card whose header it
   * used to sit in as the page's one iconed button.
   */
  async function writeFromSources() {
    startingRun = true;
    try {
      const res = await fetch(`/api/projects/${project.id}/runs`, { method: 'POST' });
      const body = await res.json().catch(() => ({}));
      if (res.status === 409) {
        toast.error(t(locale, 'projects.error-extraction-already-running'));
        return;
      }
      if (body?.error === 'no_sources') {
        toast.error(t(locale, 'projects.error-no-sources'));
        return;
      }
      if (!res.ok) {
        toast.error(body?.message ?? t(locale, 'projects.error-extraction-start-failed'));
        return;
      }
      toast.success(t(locale, 'projects.toast-extraction-started', { runId: body.runId }));
      runningRunId = body.runId as number;
      descriptionAtLaunch = shownDescription;
      // The run rewrites the description, so the draft cannot stay: it would
      // mask exactly the text the run is about to produce.
      draft = null;
      editingDescription = false;
      await invalidateAll();
      extractionRunsState = extractionRuns;
    } finally {
      startingRun = false;
    }
  }

  /** The source set changed, so reload the page data the panel and this
   * band both read. Without this, adding a source left the rest of the
   * page describing the set as it was a moment ago. */
  async function refreshSources() {
    await invalidateAll();
  }

  async function save() {
    if (voiceTone === 'custom' && !voiceToneNotes.trim()) {
      toast.error(t(locale, 'projects.error-tone-notes-required'));
      return;
    }
    saving = true;
    try {
      const res = await fetch(`/api/projects/${project.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name,
          // What is on screen: the draft when there is one, the server's
          // text otherwise. Saving the project's name or runner must not
          // write back a stale buffer over a description a run just wrote.
          description: shownDescription || null,
          defaultAgentRunner: runner,
          voiceTone: voiceTone === 'inherit' ? null : voiceTone,
          voiceToneNotes: voiceTone === 'inherit' ? null : voiceToneNotes,
        }),
      });
      if (!res.ok) {
        toast.error(
          res.status === 403
            ? t(locale, 'projects.error-admin-required')
            : t(locale, 'projects.error-save-failed'),
        );
        return;
      }
      toast.success(t(locale, 'projects.toast-saved'));
      // Persisted, so the draft has nothing left to protect: drop it and let
      // the band follow the server again.
      draft = null;
      editingDescription = false;
      await invalidateAll();
    } finally {
      saving = false;
    }
  }

  async function remove() {
    const res = await fetch(`/api/projects/${project.id}`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ confirmSlug: project.slug }),
    });
    if (!res.ok) {
      toast.error(
        res.status === 403
          ? t(locale, 'projects.error-admin-required')
          : t(locale, 'projects.error-delete-failed'),
      );
      return;
    }
    toast.success(t(locale, 'projects.toast-deleted'));
    await goto('/projects');
  }


  const unsubs: Array<() => void> = [];

  onMount(() => {
    const sseManager = getSseManager();

    unsubs.push(
      sseManager.on('project:description:updated', async (ev: MessageEvent) => {
        let payload: { projectId?: number; runId?: number } = {};
        try {
          payload = JSON.parse(ev.data);
        } catch {
          /* ignore */
        }
        if (payload.projectId !== project.id) return;
        if (runningRunId !== null && payload.runId !== runningRunId) return;
        descriptionBeforeUpdate = descriptionAtLaunch;
        runningRunId = null;
        // Nothing local may mask what the run just wrote.
        draft = null;
        await invalidateAll();
        // Wait for Svelte to flush the new props before reading anything off
        // `project`, otherwise this branch races the load.
        await tick();
        extractionRunsState = extractionRuns;
        toast.success(t(locale, 'projects.toast-description-updated'), {
          action: { label: t(locale, 'projects.view-diff-button'), onClick: () => (diffOpen = true) },
        });
      }),
    );

    unsubs.push(
      sseManager.on('run:finished', async (ev: MessageEvent) => {
        // Refresh recent extractions list when a project_extraction run finishes (success or otherwise).
        let payload: { projectId?: number | null } = {};
        try {
          payload = JSON.parse(ev.data);
        } catch {
          /* ignore */
        }
        if (payload.projectId === project.id) {
          await invalidateAll();
          extractionRunsState = extractionRuns;
        }
      }),
    );
  });

  onDestroy(() => unsubs.forEach((unsub) => unsub()));
</script>

<div class="space-y-6">
  <StreamStatusBanner
    active={extractionRunning}
    onReconnect={async () => {
      await invalidateAll();
      extractionRunsState = extractionRuns;
    }}
  />
  <div class="grid gap-4 md:grid-cols-3">
    <label class="flex flex-col gap-1 text-xs">
      {t(locale, 'projects.slug-label')}
      <Input value={project.slug} disabled />
      <span class="text-xs text-muted-foreground">{t(locale, 'projects.slug-immutable-hint')}</span>
    </label>
    <label class="flex flex-col gap-1 text-xs">
      {t(locale, 'projects.name-label')}
      <Input
        bind:value={name}
        disabled={!isAdmin}
        title={isAdmin ? undefined : t(locale, 'projects.admin-required-tooltip')}
      />
    </label>
    <label class="flex flex-col gap-1 text-xs">
      {t(locale, 'projects.runner-label')}
      <SelectField
        value={runner}
        onValueChange={(v) => (runner = v as string)}
        options={RUNNER_OPTIONS}
        fullWidth
        disabled={!isAdmin}
      />
    </label>
  </div>

  <div class="grid gap-4 md:grid-cols-3">
    <label class="flex flex-col gap-1 text-xs">
      {t(locale, 'projects.voice-label')}
      <SelectField
        value={voiceTone}
        onValueChange={(v) => (voiceTone = v as AssistTone | 'inherit')}
        options={VOICE_OPTIONS}
        fullWidth
        disabled={!isAdmin}
      />
      <span class="text-xs text-muted-foreground">
        {t(locale, 'projects.voice-hint')}
      </span>
    </label>
    {#if voiceTone === 'custom'}
      <label class="flex flex-col gap-1 text-xs md:col-span-2">
        {t(locale, 'projects.voice-custom-label')}
        <Input
          maxlength={ASSIST_TONE_NOTES_MAX}
          placeholder={t(locale, 'projects.voice-custom-placeholder')}
          bind:value={voiceToneNotes}
          disabled={!isAdmin}
        />
      </label>
    {/if}
  </div>

  <div class="flex flex-col gap-2">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <span class="text-xs">{t(locale, 'projects.description-label')}</span>
      <div class="flex flex-wrap gap-2">
        {#if !extractionRunning && shownDescription && !editingDescription}
          <Button type="button" variant="outline" size="sm" onclick={startEditing}>
            {t(locale, 'projects.edit-button')}
          </Button>
        {:else if !extractionRunning && editingDescription}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onclick={() => (editingDescription = false)}
          >
            {t(locale, 'projects.preview-button')}
          </Button>
        {/if}
        <Button
          type="button"
          variant="outline"
          size="sm"
          onclick={() => sourcesPanelEl?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
          disabled={extractionRunning}
        >
          {t(locale, 'projects.manage-sources-button')}
        </Button>
        {#if isAdmin && (shownDescription || extractionRunning || editingDescription)}
          <Button
            type="button"
            size="sm"
            onclick={writeFromSources}
            loading={startingRun}
            disabled={extractionRunning || activeSourceCount === 0}
            title={activeSourceCount === 0 ? t(locale, 'projects.error-no-sources') : undefined}
          >
            {t(locale, 'projects.regenerate-description-button')}
          </Button>
        {/if}
      </div>
    </div>
    {#if extractionRunning}
      <div
        class="flex items-center gap-2 rounded-md border px-3 py-2 text-xs {TONE_BANNER_CLASS.amber}"
      >
        <Spinner size="xs" class={TONE_TEXT_CLASS.amber} />
        <span>{t(locale, 'projects.extraction-running-body')}</span>
      </div>
      <div class="rounded-md border border-border p-3">
        <Markdown source={shownDescription} />
      </div>
    {:else if editingDescription}
      {#await import('$lib/components/MarkdownEditor.svelte')}
        <div
          class="flex items-center justify-center rounded-md border border-border text-xs text-muted-foreground"
          style="height: 540px"
        >
          <Spinner size="sm" />
        </div>
      {:then { default: MarkdownEditor }}
        <MarkdownEditor value={draft ?? ''} onchange={(v) => (draft = v)} height="540px" />
      {/await}
    {:else if shownDescription}
      <div class="rounded-md border border-border p-3">
        <Markdown source={shownDescription} />
      </div>
    {:else}
      <div
        class="flex flex-col items-center justify-center gap-4 rounded-md border border-dashed border-border bg-muted/30 px-6 py-16 text-center"
      >
        <div class="flex flex-col gap-1">
          <!-- Not an <h3>: the band's own label is not a heading, so an h3
               here jumps two levels from the page's h1 and axe flags the
               order. It is the empty state's title, styled, not structure. -->
          <p class="text-sm font-medium">{t(locale, 'projects.no-description-title')}</p>
          <p class="text-xs text-muted-foreground max-w-md">
            {t(locale, 'projects.no-description-body')}
          </p>
        </div>
        <div class="flex flex-wrap justify-center gap-2">
          {#if isAdmin && activeSourceCount > 0}
            <Button type="button" size="lg" onclick={writeFromSources} loading={startingRun}>
              {t(locale, 'projects.regenerate-description-button')}
            </Button>
          {:else}
            <Button
              type="button"
              size="lg"
              onclick={() => sourcesPanelEl?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
            >
              {t(locale, 'projects.manage-sources-button')}
            </Button>
          {/if}
          <Button
            type="button"
            variant="outline"
            size="lg"
            onclick={() => {
              draft = DESCRIPTION_SCAFFOLD;
              editingDescription = true;
            }}
          >
            {t(locale, 'projects.start-from-template-button')}
          </Button>
        </div>
      </div>
    {/if}
  </div>

  <div bind:this={sourcesPanelEl}>
    <ProjectSourcesPanel
      projectId={project.id}
      {sources}
      {isAdmin}
      {extractionRunning}
      onWriteFromSources={writeFromSources}
      onSourcesChanged={refreshSources}
    />
  </div>

  <ProjectExtractionRunsTable
    runs={extractionRunsState}
    totalCount={extractionRunsTotalCount}
    nextCursor={extractionRunsNextCursor}
    projectId={project.id}
    {highlightRunId}
  />

  {#if recommendations.length > 0}
    <div class="flex flex-col gap-2">
      <h2 class="text-sm font-medium">{t(locale, 'projects.suggested-campaigns-title')}</h2>
      <p class="text-xs text-muted-foreground">
        {t(locale, 'projects.suggested-campaigns-body')}
      </p>
      <CampaignRecommendationsList
        {recommendations}
        onUse={(rec) => goto(`/campaigns/new?recommendation=${rec.id}`)}
      />
    </div>
  {/if}

  {#if isAdmin}
    <div class="flex justify-end pt-2 border-t">
      <Button onclick={save} disabled={extractionRunning} loading={saving}
        >{t(locale, 'projects.save-button')}</Button
      >
    </div>

    <div
      class="mt-10 rounded-md border border-destructive/40 bg-destructive/5 p-4 flex items-start justify-between gap-4"
    >
      <div class="flex flex-col gap-1">
        <h2 class="text-sm font-medium text-destructive">{t(locale, 'projects.danger-zone-title')}</h2>
        <p class="text-xs text-muted-foreground">
          {t(locale, 'projects.danger-zone-body')}
        </p>
      </div>
      <Button
        variant="outline"
        size="sm"
        class="border-destructive/60 text-destructive hover:bg-destructive/10 hover:text-destructive"
        onclick={() => (deleteOpen = true)}
      >
        {t(locale, 'projects.delete-project-button')}
      </Button>
    </div>
  {/if}
</div>

<DeleteProjectDialog
  bind:open={deleteOpen}
  slug={project.slug}
  onConfirm={remove}
  onClose={() => (deleteOpen = false)}
/>

<DescriptionDiffModal
  open={diffOpen}
  onOpenChange={(v) => (diffOpen = v)}
  before={descriptionBeforeUpdate}
  after={project.description ?? ''}
/>

