<script lang="ts">
  import { goto, invalidateAll } from '$app/navigation';
  import { onMount, onDestroy } from 'svelte';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { SelectField } from '$lib/components/ui/select-field';
  import { toast } from 'svelte-sonner';
  import DeleteProjectDialog from './DeleteProjectDialog.svelte';
  import MarkdownEditor from '$lib/components/MarkdownEditor.svelte';
  import ExtractDescriptionDialog from './ExtractDescriptionDialog.svelte';
  import DescriptionDiffModal from './DescriptionDiffModal.svelte';
  import ProjectExtractionRunsTable from './ProjectExtractionRunsTable.svelte';
  import { DESCRIPTION_SCAFFOLD } from '@pitchbox/shared/project-extraction';
  import { AGENT_RUNNER_META } from '@pitchbox/shared/agents/meta';

  const RUNNER_OPTIONS = AGENT_RUNNER_META.map((m) => ({
    value: m.slug,
    label: m.implemented ? m.label : `${m.label} (coming soon)`,
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
  type Props = { project: Project; extractionRuns: ExtractionRun[] };
  let { project, extractionRuns }: Props = $props();

  // svelte-ignore state_referenced_locally
  let name = $state(project.name);
  // svelte-ignore state_referenced_locally
  let description = $state(project.description ?? '');
  // svelte-ignore state_referenced_locally
  let runner = $state(project.defaultAgentRunner);
  let saving = $state(false);
  let deleteOpen = $state(false);

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
        toast.error('Failed to save');
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
      toast.error('Failed to delete');
      return;
    }
    toast.success('Project deleted');
    await goto('/projects');
  }

  let es: EventSource | null = null;

  onMount(() => {
    es = new EventSource('/api/stream');
    es.addEventListener('project:description:updated', async (ev: MessageEvent) => {
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
      // Pull the freshly-loaded values from props after invalidation completed.
      description = project.description ?? '';
      extractionRunsState = extractionRuns;
      toast.success('Description updated', {
        action: { label: 'View diff', onClick: () => (diffOpen = true) },
      });
    });
    es.addEventListener('run:finished', async (ev: MessageEvent) => {
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
    });
  });

  onDestroy(() => es?.close());
</script>

<div class="space-y-6">
  <div class="grid gap-4 md:grid-cols-3">
    <label class="flex flex-col gap-1 text-xs">
      Slug
      <Input value={project.slug} disabled />
      <span class="text-xs text-muted-foreground">Slug cannot be changed.</span>
    </label>
    <label class="flex flex-col gap-1 text-xs">
      Name
      <Input bind:value={name} />
    </label>
    <label class="flex flex-col gap-1 text-xs">
      Default agent runner
      <SelectField
        value={runner}
        onValueChange={(v) => (runner = v as string)}
        options={RUNNER_OPTIONS}
        fullWidth
      />
    </label>
  </div>

  <div class="flex flex-col gap-2">
    <div class="flex items-center justify-between">
      <span class="text-xs">Description</span>
      <div class="flex gap-2">
        {#if !description && !extractionRunning}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onclick={() => (description = DESCRIPTION_SCAFFOLD)}
          >
            Insert template
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
    </div>
    {#if extractionRunning}
      <div
        class="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300"
      >
        An extraction is running — the editor is locked until it finishes.
      </div>
    {/if}
    <MarkdownEditor
      value={description}
      onchange={(v) => (description = v)}
      height="540px"
      disabled={extractionRunning}
    />
  </div>

  <ProjectExtractionRunsTable runs={extractionRunsState} />

  <div class="flex justify-between items-center pt-2 border-t">
    <Button onclick={save} disabled={saving || extractionRunning}>
      {saving ? 'Saving…' : 'Save'}
    </Button>
    <Button variant="destructive" onclick={() => (deleteOpen = true)}>Delete project</Button>
  </div>
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
  onLaunched={(runId) => {
    runningRunId = runId;
    descriptionAtLaunch = description;
  }}
/>

<DescriptionDiffModal
  open={diffOpen}
  onOpenChange={(v) => (diffOpen = v)}
  before={descriptionBeforeUpdate}
  after={description}
/>
