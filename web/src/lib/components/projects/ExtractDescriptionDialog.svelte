<script lang="ts">
  import * as Dialog from '$lib/components/ui/dialog';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { toast } from 'svelte-sonner';

  type Source = { kind: 'folder' | 'git'; value: string };
  type Props = {
    open: boolean;
    onOpenChange: (v: boolean) => void;
    projectId: number;
    initialSource?: Source;
    onLaunched: (runId: number) => void;
  };
  let { open, onOpenChange, projectId, initialSource, onLaunched }: Props = $props();

  // svelte-ignore state_referenced_locally
  let tab = $state<'folder' | 'git'>(initialSource?.kind ?? 'folder');
  // svelte-ignore state_referenced_locally
  let folderPath = $state(initialSource?.kind === 'folder' ? initialSource.value : '');
  // svelte-ignore state_referenced_locally
  let gitUrl = $state(initialSource?.kind === 'git' ? initialSource.value : '');
  let submitting = $state(false);

  async function submit() {
    submitting = true;
    try {
      const source: Source =
        tab === 'folder'
          ? { kind: 'folder', value: folderPath.trim() }
          : { kind: 'git', value: gitUrl.trim() };
      if (!source.value) {
        toast.error(tab === 'folder' ? 'Folder path is required' : 'Git URL is required');
        return;
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
        Point an agent runner at a local folder or a git repository.
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
      <Input bind:value={folderPath} placeholder="/absolute/path/to/folder" />
    {:else}
      <Input
        bind:value={gitUrl}
        placeholder="https://github.com/owner/repo or git@host:owner/repo.git"
      />
    {/if}

    <Dialog.Footer>
      <Button variant="ghost" onclick={() => onOpenChange(false)} disabled={submitting}
        >Cancel</Button
      >
      <Button onclick={submit} disabled={submitting}>{submitting ? 'Starting…' : 'Run'}</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
