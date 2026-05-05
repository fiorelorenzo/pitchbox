<script lang="ts">
  import * as Dialog from '$lib/components/ui/dialog';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { toast } from 'svelte-sonner';

  type Source =
    | { kind: 'folder'; value: string }
    | { kind: 'git'; value: string }
    | { kind: 'upload'; value: string };

  type Props = {
    open: boolean;
    onOpenChange: (v: boolean) => void;
    projectId: number;
    initialSource?: Source;
    onLaunched: (runId: number) => void;
  };
  let { open, onOpenChange, projectId, initialSource, onLaunched }: Props = $props();

  // svelte-ignore state_referenced_locally
  let tab = $state<'folder' | 'git'>(initialSource?.kind === 'git' ? 'git' : 'folder');
  // svelte-ignore state_referenced_locally
  let gitUrl = $state(initialSource?.kind === 'git' ? initialSource.value : '');

  let submitting = $state(false);
  let fileInput: HTMLInputElement | null = $state(null);

  type Picked = { rel: string; file: File };
  let picked = $state<Picked[]>([]);
  let skipped = $state(0);
  let folderName = $state<string>('');
  let totalBytes = $state(0);

  const MAX_FILES = 200;
  const MAX_FILE_BYTES = 200 * 1024;
  const MAX_TOTAL_BYTES = 5 * 1024 * 1024;
  const EXT_ALLOW = new Set([
    '.md',
    '.mdx',
    '.markdown',
    '.txt',
    '.rst',
    '.json',
    '.toml',
    '.yaml',
    '.yml',
    '.html',
    '.htm',
    '.svg',
  ]);
  const EXTLESS_ALLOW = /^(README|LICENSE|CHANGELOG|NOTICE|AUTHORS)([._-].*)?$/i;

  function isAcceptableName(rel: string): boolean {
    const base = rel.split('/').pop() ?? '';
    const dot = base.lastIndexOf('.');
    if (dot === -1) return EXTLESS_ALLOW.test(base);
    return EXT_ALLOW.has(base.slice(dot).toLowerCase());
  }

  function fmtBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(2)} MB`;
  }

  function onFolderChosen(ev: Event) {
    const input = ev.currentTarget as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    picked = [];
    skipped = 0;
    folderName = '';
    totalBytes = 0;

    if (files.length === 0) return;

    // Strip the leading folder name from webkitRelativePath so the upload preserves
    // the inner structure only (matches the server's expectation).
    const first = files[0].webkitRelativePath ?? '';
    const root = first.split('/')[0] ?? '';
    folderName = root;

    let total = 0;
    let kept: Picked[] = [];
    let skipCount = 0;

    for (const file of files) {
      const full = file.webkitRelativePath || file.name;
      const rel = root && full.startsWith(root + '/') ? full.slice(root.length + 1) : full;
      if (!rel) {
        skipCount++;
        continue;
      }
      if (!isAcceptableName(rel)) {
        skipCount++;
        continue;
      }
      if (file.size > MAX_FILE_BYTES) {
        skipCount++;
        continue;
      }
      total += file.size;
      kept.push({ rel, file });
    }

    if (kept.length > MAX_FILES) {
      toast.error(`Folder contains too many matching files (max ${MAX_FILES}).`);
      return;
    }
    if (total > MAX_TOTAL_BYTES) {
      toast.error(`Selected files exceed total cap (${fmtBytes(MAX_TOTAL_BYTES)}).`);
      return;
    }

    picked = kept;
    skipped = skipCount;
    totalBytes = total;
  }

  function clearPicked() {
    picked = [];
    skipped = 0;
    folderName = '';
    totalBytes = 0;
    if (fileInput) fileInput.value = '';
  }

  async function submit() {
    submitting = true;
    try {
      let source: Source;

      if (tab === 'folder') {
        if (picked.length === 0) {
          toast.error('Choose a folder first');
          return;
        }
        const fd = new FormData();
        for (const p of picked) fd.append(p.rel, p.file);
        const upRes = await fetch(`/api/projects/${projectId}/extraction-uploads`, {
          method: 'POST',
          body: fd,
        });
        const upBody = await upRes.json().catch(() => ({}));
        if (!upRes.ok) {
          toast.error(upBody?.message ?? 'Upload failed');
          return;
        }
        source = { kind: 'upload', value: upBody.path as string };
      } else {
        const v = gitUrl.trim();
        if (!v) {
          toast.error('Git URL is required');
          return;
        }
        source = { kind: 'git', value: v };
      }

      const res = await fetch(`/api/projects/${projectId}/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ source }),
      });
      const body = await res.json();
      if (res.status === 409) {
        toast.error('An extraction is already running for this project');
        return;
      }
      if (!res.ok) {
        toast.error(body?.message ?? 'Failed to start extraction');
        return;
      }
      toast.success(`Extraction run #${body.runId} started`);
      onLaunched(body.runId);
      clearPicked();
      onOpenChange(false);
    } finally {
      submitting = false;
    }
  }
</script>

<Dialog.Root {open} {onOpenChange}>
  <Dialog.Content>
    <Dialog.Header>
      <Dialog.Title>Auto-extract description</Dialog.Title>
      <Dialog.Description>
        Upload a folder from your machine or point to a git repository.
      </Dialog.Description>
    </Dialog.Header>

    <div class="flex gap-2 border-b mb-3">
      <button
        type="button"
        class={`px-3 py-2 text-sm border-b-2 ${tab === 'folder' ? 'border-foreground' : 'border-transparent text-muted-foreground'}`}
        onclick={() => (tab = 'folder')}
      >
        From folder
      </button>
      <button
        type="button"
        class={`px-3 py-2 text-sm border-b-2 ${tab === 'git' ? 'border-foreground' : 'border-transparent text-muted-foreground'}`}
        onclick={() => (tab = 'git')}
      >
        From git repo
      </button>
    </div>

    {#if tab === 'folder'}
      <div class="flex flex-col gap-2">
        <input
          bind:this={fileInput}
          type="file"
          /* svelte-ignore element_invalid_self_closing_tag */
          webkitdirectory
          multiple
          class="hidden"
          onchange={onFolderChosen}
        />
        <div class="flex items-center gap-2">
          <Button type="button" variant="outline" onclick={() => fileInput?.click()}>
            Choose folder…
          </Button>
          {#if picked.length > 0}
            <Button type="button" variant="ghost" size="sm" onclick={clearPicked}>Clear</Button>
          {/if}
        </div>

        {#if picked.length > 0}
          <p class="text-xs text-muted-foreground">
            <span class="text-foreground font-medium">{folderName}</span>
            — {picked.length} file{picked.length === 1 ? '' : 's'} ({fmtBytes(totalBytes)}){#if skipped > 0}, {skipped} skipped{/if}.
          </p>
        {:else}
          <p class="text-xs text-muted-foreground">
            Only text files relevant to a product description are uploaded (markdown, JSON, TOML,
            YAML, HTML, README/LICENSE). Per-file cap {fmtBytes(MAX_FILE_BYTES)}, total cap
            {fmtBytes(MAX_TOTAL_BYTES)}, max {MAX_FILES} files.
          </p>
        {/if}
      </div>
    {:else}
      <Input
        bind:value={gitUrl}
        placeholder="https://github.com/owner/repo or git@host:owner/repo.git"
      />
    {/if}

    <Dialog.Footer>
      <Button variant="ghost" onclick={() => onOpenChange(false)} disabled={submitting}>
        Cancel
      </Button>
      <Button onclick={submit} disabled={submitting}>{submitting ? 'Starting…' : 'Run'}</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
