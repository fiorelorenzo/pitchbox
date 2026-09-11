<script lang="ts">
  // The sources a project's description is grounded in (#432). Replaces
  // ExtractDescriptionDialog's "pick one source for one run, remember the
  // last tab" model: a source is now a row in a set a person manages - add
  // it, see when it was last fetched and why it failed if it did, re-sync
  // it, remove it. `folder`/`git`/`upload` still originate from running an
  // extraction (cli/src/commands/project.ts's recordExtractionSource, via
  // "Run extraction" below for `git`, or the CLI for a local folder) since
  // their config is a local/ephemeral path with nothing to fetch on its
  // own; every other kind is addable here directly by a single string value.
  //
  // `website`, `mastodon_account` and `hackernews_author` (#472, #437) all
  // have a real fetcher wired up (shared/src/project-source-sync.ts).
  //
  // `linkedin_post`/`linkedin_profile` (#436, spike #435) are different: a
  // fresh one is honestly pending, never failed - nothing here fetches it,
  // the extension's own content script fills it the next time the human
  // opens the matching LinkedIn page, and a re-sync click can only clear an
  // already-filled row back to pending for a second visit, never fetch
  // anything itself. `linkedin_company` is a real `ProjectSourceKind` but
  // deliberately left out of `ADD_KIND_OPTIONS` below - the selector work to
  // fill one hasn't shipped, so offering the button would create a row that
  // can only ever say "waiting for you to open it", forever.
  import { page } from '$app/stores';
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
  import type { ProjectSourceKind } from '@pitchbox/shared/project-sources';
  import { t, type Locale } from '$lib/i18n/index.js';

  // Re-exported so a consumer (the project page's load function/props) can
  // still name this type off the panel, without this panel keeping its own
  // second copy of the kind list to drift from `PROJECT_SOURCE_KINDS` - a
  // type-only import, erased at build time, so it never pulls
  // `@pitchbox/shared`'s DB-touching runtime code into the client bundle
  // (same reasoning `AGENTS.md` gives for never importing
  // `@pitchbox/shared/db` from client code).
  export type { ProjectSourceKind };

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

  const locale = $derived($page.data.locale as Locale);

  // svelte-ignore state_referenced_locally
  let sourcesState = $state(sources);
  $effect(() => {
    sourcesState = sources;
  });

  const KIND_LABEL = $derived<Record<ProjectSourceKind, string>>({
    folder: t(locale, 'projects.source-kind.folder'),
    git: t(locale, 'projects.source-kind.git'),
    upload: t(locale, 'projects.source-kind.upload'),
    github: t(locale, 'projects.source-kind.github'),
    website: t(locale, 'projects.source-kind.website'),
    linkedin_company: t(locale, 'projects.source-kind.linkedin_company'),
    linkedin_profile: t(locale, 'projects.source-kind.linkedin_profile'),
    linkedin_post: t(locale, 'projects.source-kind.linkedin_post'),
    mastodon_account: t(locale, 'projects.source-kind.mastodon_account'),
    hackernews_author: t(locale, 'projects.source-kind.hackernews_author'),
  });

  // Kinds this panel's Add form can create directly: value-only sources.
  // `folder`/`upload` are excluded - see the file header comment.
  // `linkedin_company` is excluded too, on purpose - see the same comment.
  const ADD_KIND_OPTIONS = $derived<Array<{ value: ProjectSourceKind; label: string }>>([
    { value: 'git', label: KIND_LABEL.git },
    { value: 'github', label: KIND_LABEL.github },
    { value: 'website', label: KIND_LABEL.website },
    { value: 'mastodon_account', label: KIND_LABEL.mastodon_account },
    { value: 'hackernews_author', label: KIND_LABEL.hackernews_author },
    { value: 'linkedin_profile', label: KIND_LABEL.linkedin_profile },
    { value: 'linkedin_post', label: KIND_LABEL.linkedin_post },
  ]);

  const VALUE_PLACEHOLDER: Partial<Record<ProjectSourceKind, string>> = {
    git: 'https://github.com/owner/repo.git or git@host:owner/repo.git',
    github: 'https://github.com/owner/repo or owner/repo',
    website: 'https://example.com',
    mastodon_account: 'https://mastodon.social/@handle',
    hackernews_author: 'pg or https://news.ycombinator.com/user?id=pg',
    linkedin_profile: 'https://www.linkedin.com/in/example',
    linkedin_post: 'https://www.linkedin.com/posts/example_activity',
  };

  // `config`'s shape is kind-specific: most kinds key it `value`, but
  // `website` keys it `url`, `mastodon_account` splits it into
  // `instanceUrl`/`acct`, and `hackernews_author` keys it `username` - see
  // shared/src/{website,mastodon,hackernews}-source.ts.
  function sourceValue(s: ProjectSource): string {
    if (s.kind === 'website') {
      const v = s.config?.url;
      return typeof v === 'string' ? v : '';
    }
    if (s.kind === 'mastodon_account') {
      const instanceUrl = s.config?.instanceUrl;
      const acct = s.config?.acct;
      return typeof instanceUrl === 'string' && typeof acct === 'string'
        ? `${instanceUrl}/@${acct}`
        : '';
    }
    if (s.kind === 'hackernews_author') {
      const v = s.config?.username;
      return typeof v === 'string' ? v : '';
    }
    const v = s.config?.value;
    return typeof v === 'string' ? v : '';
  }

  function status(s: ProjectSource): 'synced' | 'failed' | 'pending' {
    if (s.fetchError) return 'failed';
    if (s.fetchedAt) return 'synced';
    return 'pending';
  }

  // The two kinds a content script fills passively, never a server fetch
  // (#436, spike #435) - used to keep the add/re-sync toasts and the table's
  // pending caption honest instead of implying a fetch that never happens.
  function isPassivelyFilledLinkedInSource(kind: ProjectSourceKind): boolean {
    return kind === 'linkedin_post' || kind === 'linkedin_profile';
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
      toast.error(t(locale, 'projects.error-enter-value-first'));
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
        toast.error(
          res.status === 403
            ? t(locale, 'projects.error-admin-required')
            : (body?.message ?? t(locale, 'projects.error-add-source-failed')),
        );
        return;
      }
      sourcesState = [...sourcesState, body.source as ProjectSource];
      addValue = '';
      if (isPassivelyFilledLinkedInSource(body.source?.kind)) {
        toast.info(t(locale, 'projects.toast-linkedin-waiting'));
      } else if (body.source?.fetchError) {
        toast.warning(t(locale, 'projects.toast-added-sync-failed', { error: body.source.fetchError }));
      } else {
        toast.success(t(locale, 'projects.toast-source-added'));
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
        toast.error(
          res.status === 403
            ? t(locale, 'projects.error-admin-required')
            : (body?.message ?? t(locale, 'projects.error-sync-failed')),
        );
        return;
      }
      sourcesState = sourcesState.map((s) => (s.id === source.id ? (body.source as ProjectSource) : s));
      if (body.ok) {
        toast.success(t(locale, 'projects.toast-synced'));
      } else if (body.source?.fetchError) {
        toast.warning(body.source.fetchError);
      } else if (isPassivelyFilledLinkedInSource(source.kind)) {
        toast.info(t(locale, 'projects.toast-linkedin-flip-pending'));
      } else {
        toast.warning(t(locale, 'projects.error-sync-failed'));
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
        toast.error(t(locale, 'projects.error-extraction-already-running'));
        return;
      }
      if (!res.ok) {
        toast.error(body?.message ?? t(locale, 'projects.error-extraction-start-failed'));
        return;
      }
      toast.success(t(locale, 'projects.toast-extraction-started', { runId: body.runId }));
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
        toast.error(
          res.status === 403
            ? t(locale, 'projects.error-admin-required')
            : t(locale, 'projects.error-remove-source-failed'),
        );
        return;
      }
      sourcesState = sourcesState.filter((s) => s.id !== removeTarget!.id);
      toast.success(t(locale, 'projects.toast-source-removed'));
      removeTarget = null;
    } finally {
      removing = false;
    }
  }
</script>

<Card.Root size="sm">
  <Card.Header>
    <Card.Title class="text-base">{t(locale, 'projects.sources-panel-title')}</Card.Title>
    <Card.Description class="text-xs">
      {t(locale, 'projects.sources-panel-description')}
    </Card.Description>
  </Card.Header>
  <Card.Content class="flex flex-col gap-4">
    {#if isAdmin}
      <div class="flex flex-col gap-2 sm:flex-row sm:items-end">
        <label class="flex flex-col gap-1 text-xs sm:w-56">
          {t(locale, 'projects.source-kind-label')}
          <SelectField
            value={addKind}
            onValueChange={(v) => (addKind = v as ProjectSourceKind)}
            options={ADD_KIND_OPTIONS}
            fullWidth
          />
        </label>
        <label class="flex flex-1 flex-col gap-1 text-xs">
          {t(locale, 'projects.source-value-label')}
          <Input
            bind:value={addValue}
            placeholder={VALUE_PLACEHOLDER[addKind]}
            onkeydown={(e) => e.key === 'Enter' && addSource()}
          />
        </label>
        <Button type="button" onclick={addSource} loading={adding}
          >{t(locale, 'projects.add-source-button')}</Button
        >
      </div>
    {/if}

    {#if sourcesState.length === 0}
      <p class="text-xs text-muted-foreground">
        {t(locale, 'projects.sources-empty')}
      </p>
    {:else}
      <Table.Root>
        <Table.Header>
          <Table.Row>
            <Table.Head>{t(locale, 'projects.source-kind-label')}</Table.Head>
            <Table.Head>{t(locale, 'projects.source-value-label')}</Table.Head>
            <Table.Head>{t(locale, 'projects.status-label')}</Table.Head>
            <Table.Head>{t(locale, 'projects.last-fetched-label')}</Table.Head>
            <Table.Head class="text-right">{t(locale, 'projects.actions-label')}</Table.Head>
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
                  {:else if status(s) === 'pending' && isPassivelyFilledLinkedInSource(s.kind)}
                    <span class="max-w-64 text-[11px] text-muted-foreground">
                      {t(locale, 'projects.toast-linkedin-waiting')}
                    </span>
                  {/if}
                </div>
              </Table.Cell>
              <Table.Cell class="text-xs text-muted-foreground">
                {s.fetchedAt ? relativeTime(s.fetchedAt) : t(locale, 'projects.never-label')}
              </Table.Cell>
              <Table.Cell class="text-right">
                {#if isAdmin}
                  <div class="flex justify-end gap-1">
                    {#if s.kind === 'git'}
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={t(locale, 'projects.run-extraction-aria')}
                        title={t(locale, 'projects.run-extraction-aria')}
                        onclick={() => runExtraction(s)}
                        disabled={runningFromId === s.id}
                      >
                        <Play class="size-4" />
                      </Button>
                    {/if}
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={t(locale, 'projects.resync-aria')}
                      title={t(locale, 'projects.resync-aria')}
                      onclick={() => resync(s)}
                      disabled={syncingId === s.id}
                    >
                      <RefreshCw class={`size-4 ${syncingId === s.id ? 'animate-spin' : ''}`} />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={t(locale, 'projects.remove-aria')}
                      title={t(locale, 'projects.remove-aria')}
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
        {t(locale, 'projects.remove-source-title', {
          kind: removeTarget ? KIND_LABEL[removeTarget.kind] : t(locale, 'projects.remove-source-generic'),
        })}
      </AlertDialog.Title>
      <AlertDialog.Description>
        {t(locale, 'projects.remove-source-body', {
          value: removeTarget ? sourceValue(removeTarget) : '',
        })}
      </AlertDialog.Description>
    </AlertDialog.Header>
    <AlertDialog.Footer>
      <AlertDialog.Cancel onclick={() => (removeTarget = null)}
        >{t(locale, 'projects.cancel-button')}</AlertDialog.Cancel
      >
      <AlertDialog.Action onclick={confirmRemove} disabled={removing}>
        {removing ? t(locale, 'projects.removing-button') : t(locale, 'projects.remove-button')}
      </AlertDialog.Action>
    </AlertDialog.Footer>
  </AlertDialog.Content>
</AlertDialog.Root>
