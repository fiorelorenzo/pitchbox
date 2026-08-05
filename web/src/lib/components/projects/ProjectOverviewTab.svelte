<script lang="ts">
  import { goto, invalidateAll } from '$app/navigation';
  import { onMount, onDestroy, tick } from 'svelte';
  import { Button } from '$lib/components/ui/button';
  import Spinner from '$lib/components/Spinner.svelte';
  import { Input } from '$lib/components/ui/input';
  import { SelectField } from '$lib/components/ui/select-field';
  import { toast } from 'svelte-sonner';
  import DeleteProjectDialog from './DeleteProjectDialog.svelte';
  import Markdown from '$lib/components/Markdown.svelte';
  import ExtractDescriptionDialog from './ExtractDescriptionDialog.svelte';
  import DescriptionDiffModal from './DescriptionDiffModal.svelte';
  import ProjectExtractionRunsTable from './ProjectExtractionRunsTable.svelte';
  import CampaignRecommendationsList, {
    type Recommendation,
  } from './CampaignRecommendationsList.svelte';
  import { DESCRIPTION_SCAFFOLD } from '@pitchbox/shared/project-extraction';
  import { AGENT_RUNNER_META } from '@pitchbox/shared/agents/meta';
  import { TONE_BANNER_CLASS, TONE_TEXT_CLASS } from '$lib/config/status-badges';
  import StreamStatusBanner from '$lib/realtime/StreamStatusBanner.svelte';
  import { getSseManager } from '$lib/realtime/sse';

  const RUNNER_OPTIONS = AGENT_RUNNER_META.map((m) => ({
    value: m.slug,
    label: m.implemented ? m.label : `${m.label} (not available yet)`,
    disabled: !m.implemented,
  }));

  type Project = {
    id: number;
    slug: string;
    name: string;
    description: string | null;
    defaultAgentRunner: string;
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
    params: { source?: { kind: string; value: string } } | null;
  };
  type Props = {
    project: Project;
    extractionRuns: ExtractionRun[];
    extractionRunsTotalCount: number;
    extractionRunsNextCursor: { startedAt: string; id: string } | null;
    recommendations: Recommendation[];
    isAdmin: boolean;
    highlightRunId?: number | null;
  };
  let {
    project,
    extractionRuns,
    extractionRunsTotalCount,
    extractionRunsNextCursor,
    recommendations,
    isAdmin,
    highlightRunId = null,
  }: Props = $props();

  // svelte-ignore state_referenced_locally
  let name = $state(project.name);
  // svelte-ignore state_referenced_locally
  let description = $state(project.description ?? '');
  // svelte-ignore state_referenced_locally
  let runner = $state(project.defaultAgentRunner);
  let saving = $state(false);
  let deleteOpen = $state(false);
  // Gates loading the bytemd editor stack: only fetched once the user
  // actually starts editing, keeping the read path free of it.
  let editingDescription = $state(false);

  let extractOpen = $state(false);
  let diffOpen = $state(false);
  let runningRunId = $state<number | null>(null);
  let descriptionAtLaunch = $state<string>('');
  let descriptionBeforeUpdate = $state<string>('');
  // svelte-ignore state_referenced_locally
  let extractionRunsState = $state(extractionRuns);

  let extractionRunning = $derived(
    runningRunId !== null || extractionRunsState.some((r) => r.status === 'running'),
  );

  // Keep the local description in sync with the upstream prop. Two cases this
  // covers:
  //   1) Fresh navigation onto a project whose description was populated by a
  //      prior auto-extract: the $state initializer above runs once and may
  //      capture an early-mount value of project.description. The effect
  //      below re-syncs after props settle.
  //   2) Auto-extract finishes in this tab: after invalidateAll() the prop
  //      updates; the SSE handler also writes `description` directly, but we
  //      keep this effect as a safety net so the editor never lags behind
  //      project.description while no extraction is running.
  // We only overwrite the local state when the user hasn't started editing
  // (i.e. local description is empty) - otherwise we'd clobber edits.
  $effect(() => {
    const upstream = project.description ?? '';
    if (!extractionRunning && upstream && !description) {
      description = upstream;
    }
  });

  // Keep the runs table reactive to upstream prop changes (post-invalidate).
  $effect(() => {
    extractionRunsState = extractionRuns;
  });
  // svelte-ignore state_referenced_locally
  let initialSource = $state<{ kind: 'folder' | 'git'; value: string } | undefined>(
    (() => {
      const last = extractionRuns[0]?.params?.source;
      if (last && (last.kind === 'folder' || last.kind === 'git') && typeof last.value === 'string') {
        return { kind: last.kind, value: last.value };
      }
      return undefined;
    })(),
  );

  async function save() {
    saving = true;
    try {
      const res = await fetch(`/api/projects/${project.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name,
          description: description || null,
          defaultAgentRunner: runner,
        }),
      });
      if (!res.ok) {
        toast.error(res.status === 403 ? 'You need admin access for that' : 'Failed to save');
        return;
      }
      toast.success('Saved');
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
      toast.error(res.status === 403 ? 'You need admin access for that' : 'Failed to delete');
      return;
    }
    toast.success('Project deleted');
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
        await invalidateAll();
        // Wait for Svelte to flush the new props before reading project.description,
        // otherwise this branch may race with the load and re-show the empty state.
        await tick();
        description = project.description ?? '';
        editingDescription = true;
        extractionRunsState = extractionRuns;
        toast.success('Description updated', {
          action: { label: 'View diff', onClick: () => (diffOpen = true) },
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
      Slug
      <Input value={project.slug} disabled />
      <span class="text-xs text-muted-foreground">Slug cannot be changed.</span>
    </label>
    <label class="flex flex-col gap-1 text-xs">
      Name
      <Input bind:value={name} disabled={!isAdmin} title={isAdmin ? undefined : 'Admin access required'} />
    </label>
    <label class="flex flex-col gap-1 text-xs">
      Default agent runner
      <SelectField
        value={runner}
        onValueChange={(v) => (runner = v as string)}
        options={RUNNER_OPTIONS}
        fullWidth
        disabled={!isAdmin}
      />
    </label>
  </div>

  <div class="flex flex-col gap-2">
    <div class="flex items-center justify-between">
      <span class="text-xs">Description</span>
      {#if description || extractionRunning || editingDescription}
        <div class="flex gap-2">
          {#if !extractionRunning && description && !editingDescription}
            <Button
              type="button"
              variant="outline"
              size="sm"
              onclick={() => (editingDescription = true)}
            >
              Edit
            </Button>
          {:else if !extractionRunning && editingDescription}
            <Button
              type="button"
              variant="outline"
              size="sm"
              onclick={() => (editingDescription = false)}
            >
              Preview
            </Button>
          {/if}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onclick={() => (extractOpen = true)}
            disabled={extractionRunning}
          >
            Auto-extract
          </Button>
        </div>
      {/if}
    </div>
    {#if extractionRunning}
      <div
        class="flex items-center gap-2 rounded-md border px-3 py-2 text-xs {TONE_BANNER_CLASS.amber}"
      >
        <Spinner size="xs" class={TONE_TEXT_CLASS.amber} />
        <span>An extraction is running - editing is locked until it finishes.</span>
      </div>
      <div class="rounded-md border border-border p-3">
        <Markdown source={description} />
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
        <MarkdownEditor value={description} onchange={(v) => (description = v)} height="540px" />
      {/await}
    {:else if description}
      <div class="rounded-md border border-border p-3">
        <Markdown source={description} />
      </div>
    {:else}
      <div
        class="flex flex-col items-center justify-center gap-4 rounded-md border border-dashed border-border bg-muted/30 px-6 py-16 text-center"
      >
        <div class="flex flex-col gap-1">
          <h3 class="text-sm font-medium">No description yet</h3>
          <p class="text-xs text-muted-foreground max-w-md">
            The description grounds the agent during scouting and drafting. Auto-extract pulls one
            from your codebase or a public Git repo, or start from a blank template.
          </p>
        </div>
        <div class="flex gap-2">
          <Button type="button" size="lg" onclick={() => (extractOpen = true)}>Auto-extract</Button>
          <Button
            type="button"
            variant="outline"
            size="lg"
            onclick={() => {
              description = DESCRIPTION_SCAFFOLD;
              editingDescription = true;
            }}
          >
            Start from template
          </Button>
        </div>
      </div>
    {/if}
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
      <h3 class="text-sm font-medium">Suggested campaigns</h3>
      <p class="text-xs text-muted-foreground">
        From the latest project description extraction. Click "Use this" to start a campaign from a
        suggestion.
      </p>
      <CampaignRecommendationsList
        {recommendations}
        onUse={(rec) => goto(`/campaigns/new?recommendation=${rec.id}`)}
      />
    </div>
  {/if}

  {#if isAdmin}
    <div class="flex justify-end pt-2 border-t">
      <Button onclick={save} disabled={extractionRunning} loading={saving}>Save</Button>
    </div>

    <div
      class="mt-10 rounded-md border border-destructive/40 bg-destructive/5 p-4 flex items-start justify-between gap-4"
    >
      <div class="flex flex-col gap-1">
        <h3 class="text-sm font-medium text-destructive">Danger zone</h3>
        <p class="text-xs text-muted-foreground">
          Permanently delete this project and all its data. This cannot be undone.
        </p>
      </div>
      <Button
        variant="outline"
        size="sm"
        class="border-destructive/60 text-destructive hover:bg-destructive/10 hover:text-destructive"
        onclick={() => (deleteOpen = true)}
      >
        Delete project
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

<ExtractDescriptionDialog
  open={extractOpen}
  onOpenChange={(v) => (extractOpen = v)}
  projectId={project.id}
  {initialSource}
  onLaunched={async (runId) => {
    runningRunId = runId;
    descriptionAtLaunch = description;
    await invalidateAll();
    extractionRunsState = extractionRuns;
  }}
/>

<DescriptionDiffModal
  open={diffOpen}
  onOpenChange={(v) => (diffOpen = v)}
  before={descriptionBeforeUpdate}
  after={description}
/>
