<script lang="ts">
  // The sources a project's description is grounded in (#432). Replaces
  // ExtractDescriptionDialog's "pick one source for one run, remember the
  // last tab" model: a source is now a row in a set a person manages - add
  // it, see when it was last fetched and why it failed if it did, re-sync
  // it, remove it. `folder`/`git`/`upload` still originate from running an
  // extraction (cli/src/commands/project.ts's recordExtractionSource, via
  // "Run extraction" below for `git`, or the CLI for a local folder) since
  // their config is a local/ephemeral path with nothing to fetch on its
  // own; every other kind is addable here directly by URL.
  //
  // `website` (#433) and the three `linkedin_*` kinds (#435's spike) have no
  // fetcher wired up yet - re-syncing one of those, or a folder/git/upload
  // row, comes back with a fetch_error explaining that in words
  // (shared/src/project-source-sync.ts) rather than crashing or pretending
  // to have succeeded, so those kinds still render as a source you can add
  // and see.
  import * as Card from '$lib/components/ui/card';
  import * as Table from '$lib/components/ui/table';
  import * as AlertDialog from '$lib/components/ui/alert-dialog';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { SelectField } from '$lib/components/ui/select-field';
  import StatusBadge from '$lib/components/StatusBadge.svelte';
  import { relativeTime } from '$lib/utils/time';
  import { toast } from 'svelte-sonner';
  import { Trash2, RefreshCw, Play } from '@lucide/svelte';

  export type ProjectSourceKind =
    | 'folder'
    | 'git'
    | 'upload'
    | 'github'
    | 'website'
    | 'linkedin_company'
    | 'linkedin_profile'
    | 'linkedin_post';

  export type ProjectSource = {
    id: number;
    kind: ProjectSourceKind;
    config: Record<string, unknown>;
    output: Record<string, unknown> | null;
    active: boolean;
    fetchedAt: string | null;
    fetchError: string | null;
  };

  type Props = {
    projectId: number;
    sources: ProjectSource[];
    isAdmin: boolean;
    onExtractionLaunched: (runId: number) => void;
  };
  let { projectId, sources, isAdmin, onExtractionLaunched }: Props = $props();

  // svelte-ignore state_referenced_locally
  let sourcesState = $state(sources);
  $effect(() => {
    sourcesState = sources;
  });

  const KIND_LABEL: Record<ProjectSourceKind, string> = {
    folder: 'Local folder',
    git: 'Git repository',
    upload: 'Uploaded folder',
    github: 'GitHub repository',
    website: 'Website',
    linkedin_company: 'LinkedIn company page',
    linkedin_profile: 'LinkedIn profile',
    linkedin_post: 'LinkedIn post',
  };

  // Kinds this panel's Add form can create directly: value-only sources.
  // `folder`/`upload` are excluded - see the file header comment.
  const ADD_KIND_OPTIONS: Array<{ value: ProjectSourceKind; label: string }> = [
    { value: 'git', label: KIND_LABEL.git },
    { value: 'github', label: KIND_LABEL.github },
    { value: 'website', label: KIND_LABEL.website },
    { value: 'linkedin_company', label: KIND_LABEL.linkedin_company },
    { value: 'linkedin_profile', label: KIND_LABEL.linkedin_profile },
    { value: 'linkedin_post', label: KIND_LABEL.linkedin_post },
  ];

  const VALUE_PLACEHOLDER: Partial<Record<ProjectSourceKind, string>> = {
    git: 'https://github.com/owner/repo.git or git@host:owner/repo.git',
    github: 'https://github.com/owner/repo or owner/repo',
    website: 'https://example.com',
    linkedin_company: 'https://www.linkedin.com/company/example',
    linkedin_profile: 'https://www.linkedin.com/in/example',
    linkedin_post: 'https://www.linkedin.com/posts/example_activity',
  };

  function sourceValue(s: ProjectSource): string {
    const v = s.config?.value;
    return typeof v === 'string' ? v : '';
  }

  function status(s: ProjectSource): 'synced' | 'failed' | 'pending' {
    if (s.fetchError) return 'failed';
    if (s.fetchedAt) return 'synced';
    return 'pending';
  }

  let addKind = $state<ProjectSourceKind>('git');
  let addValue = $state('');
  let adding = $state(false);
  let syncingId = $state<number | null>(null);
  let runningFromId = $state<number | null>(null);
  let removeTarget = $state<ProjectSource | null>(null);
  let removing = $state(false);

  async function addSource() {
    const value = addValue.trim();
    if (!value) {
      toast.error('Enter a value first');
      return;
    }
    adding = true;
    try {
      const res = await fetch(`/api/projects/${projectId}/sources`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: addKind, value }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(res.status === 403 ? 'You need admin access for that' : (body?.message ?? 'Failed to add source'));
        return;
      }
      sourcesState = [...sourcesState, body.source as ProjectSource];
      addValue = '';
      if (body.source?.fetchError) {
        toast.warning(`Added, but the first sync failed: ${body.source.fetchError}`);
      } else {
        toast.success('Source added');
      }
    } finally {
      adding = false;
    }
  }

  async function resync(source: ProjectSource) {
    syncingId = source.id;
    try {
      const res = await fetch(`/api/projects/${projectId}/sources/${source.id}/sync`, {
        method: 'POST',
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(res.status === 403 ? 'You need admin access for that' : (body?.message ?? 'Sync failed'));
        return;
      }
      sourcesState = sourcesState.map((s) => (s.id === source.id ? (body.source as ProjectSource) : s));
      if (body.ok) {
        toast.success('Synced');
      } else {
        toast.warning(body.source?.fetchError ?? 'Sync failed');
      }
    } finally {
      syncingId = null;
    }
  }

  async function runExtraction(source: ProjectSource) {
    runningFromId = source.id;
    try {
      const res = await fetch(`/api/projects/${projectId}/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ source: { kind: 'git', value: sourceValue(source) } }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.status === 409) {
        toast.error('An extraction is already running for this project');
        return;
      }
      if (!res.ok) {
        toast.error(body?.message ?? 'Failed to start extraction');
        return;
      }
      toast.success(`Extraction run #${body.runId} started`);
      onExtractionLaunched(body.runId);
    } finally {
      runningFromId = null;
    }
  }

  async function confirmRemove() {
    if (!removeTarget) return;
    removing = true;
    try {
      const res = await fetch(`/api/projects/${projectId}/sources/${removeTarget.id}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        toast.error(res.status === 403 ? 'You need admin access for that' : 'Failed to remove source');
        return;
      }
      sourcesState = sourcesState.filter((s) => s.id !== removeTarget!.id);
      toast.success('Source removed');
      removeTarget = null;
    } finally {
      removing = false;
    }
  }
</script>

<Card.Root size="sm">
  <Card.Header>
    <Card.Title class="text-base">Sources</Card.Title>
    <Card.Description class="text-xs">
      What the description is grounded in. Add a source, see when it was last fetched, re-sync it,
      or remove it - a removed source is never used again.
    </Card.Description>
  </Card.Header>
  <Card.Content class="flex flex-col gap-4">
    {#if isAdmin}
      <div class="flex flex-col gap-2 sm:flex-row sm:items-end">
        <label class="flex flex-col gap-1 text-xs sm:w-56">
          Kind
          <SelectField
            value={addKind}
            onValueChange={(v) => (addKind = v as ProjectSourceKind)}
            options={ADD_KIND_OPTIONS}
            fullWidth
          />
        </label>
        <label class="flex flex-1 flex-col gap-1 text-xs">
          Value
          <Input
            bind:value={addValue}
            placeholder={VALUE_PLACEHOLDER[addKind]}
            onkeydown={(e) => e.key === 'Enter' && addSource()}
          />
        </label>
        <Button type="button" onclick={addSource} loading={adding}>Add source</Button>
      </div>
    {/if}

    {#if sourcesState.length === 0}
      <p class="text-xs text-muted-foreground">
        No sources yet. Add a URL above, or start an extraction from a local folder.
      </p>
    {:else}
      <Table.Root>
        <Table.Header>
          <Table.Row>
            <Table.Head>Kind</Table.Head>
            <Table.Head>Value</Table.Head>
            <Table.Head>Status</Table.Head>
            <Table.Head>Last fetched</Table.Head>
            <Table.Head class="text-right">Actions</Table.Head>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {#each sourcesState as s (s.id)}
            <Table.Row>
              <Table.Cell class="text-xs">{KIND_LABEL[s.kind] ?? s.kind}</Table.Cell>
              <Table.Cell class="max-w-64 truncate font-mono text-xs" title={sourceValue(s)}>
                {sourceValue(s) || '-'}
              </Table.Cell>
              <Table.Cell>
                <div class="flex flex-col gap-1">
                  <StatusBadge domain="project-source-status" value={status(s)} />
                  {#if s.fetchError}
                    <span class="max-w-64 text-[11px] text-rose-600 dark:text-rose-400" title={s.fetchError}>
                      {s.fetchError}
                    </span>
                  {/if}
                </div>
              </Table.Cell>
              <Table.Cell class="text-xs text-muted-foreground">
                {s.fetchedAt ? relativeTime(s.fetchedAt) : 'never'}
              </Table.Cell>
              <Table.Cell class="text-right">
                {#if isAdmin}
                  <div class="flex justify-end gap-1">
                    {#if s.kind === 'git'}
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label="Run extraction with this source"
                        title="Run extraction with this source"
                        onclick={() => runExtraction(s)}
                        disabled={runningFromId === s.id}
                      >
                        <Play class="size-4" />
                      </Button>
                    {/if}
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="Re-sync"
                      title="Re-sync"
                      onclick={() => resync(s)}
                      disabled={syncingId === s.id}
                    >
                      <RefreshCw class={`size-4 ${syncingId === s.id ? 'animate-spin' : ''}`} />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="Remove"
                      title="Remove"
                      class="text-muted-foreground hover:text-destructive"
                      onclick={() => (removeTarget = s)}
                    >
                      <Trash2 class="size-4" />
                    </Button>
                  </div>
                {/if}
              </Table.Cell>
            </Table.Row>
          {/each}
        </Table.Body>
      </Table.Root>
    {/if}
  </Card.Content>
</Card.Root>

<AlertDialog.Root open={removeTarget !== null} onOpenChange={(v) => !v && (removeTarget = null)}>
  <AlertDialog.Content>
    <AlertDialog.Header>
      <AlertDialog.Title>
        Remove this {removeTarget ? KIND_LABEL[removeTarget.kind] : 'source'}?
      </AlertDialog.Title>
      <AlertDialog.Description>
        {removeTarget ? sourceValue(removeTarget) : ''} will no longer be used for this project's
        description. There is no undo.
      </AlertDialog.Description>
    </AlertDialog.Header>
    <AlertDialog.Footer>
      <AlertDialog.Cancel onclick={() => (removeTarget = null)}>Cancel</AlertDialog.Cancel>
      <AlertDialog.Action onclick={confirmRemove} disabled={removing}>
        {removing ? 'Removing…' : 'Remove'}
      </AlertDialog.Action>
    </AlertDialog.Footer>
  </AlertDialog.Content>
</AlertDialog.Root>
