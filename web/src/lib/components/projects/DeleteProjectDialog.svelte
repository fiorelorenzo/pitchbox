<script lang="ts">
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';

  type Props = {
    open: boolean;
    slug: string;
    onConfirm: () => void | Promise<void>;
    onClose: () => void;
  };
  let { open = $bindable(), slug, onConfirm, onClose }: Props = $props();
  let typed = $state('');
  let busy = $state(false);

  async function confirm() {
    if (typed !== slug || busy) return;
    busy = true;
    try {
      await onConfirm();
    } finally {
      busy = false;
    }
  }
</script>

{#if open}
  <div
    class="fixed inset-0 bg-black/40 z-40"
    onclick={onClose}
    role="button"
    tabindex="-1"
    aria-label="Close dialog"
    onkeydown={(e) => e.key === 'Escape' && onClose()}
  ></div>
  <div class="fixed inset-0 z-50 flex items-center justify-center p-4 pointer-events-none">
    <div class="bg-background border border-border rounded-lg p-6 w-full max-w-md pointer-events-auto space-y-4">
      <h3 class="font-medium">Delete project</h3>
      <p class="text-sm text-muted-foreground">
        This will cascade-delete all campaigns, runs, drafts, configs, and accounts of this project.
        Type the project slug <code class="bg-muted px-1 rounded">{slug}</code> to confirm.
      </p>
      <label class="flex flex-col gap-1 text-xs">
        Slug
        <Input bind:value={typed} />
      </label>
      <div class="flex justify-end gap-2">
        <Button variant="ghost" type="button" onclick={onClose}>Cancel</Button>
        <Button
          type="button"
          variant="destructive"
          disabled={typed !== slug || busy}
          onclick={confirm}
        >
          {busy ? 'Deleting…' : 'Delete project'}
        </Button>
      </div>
    </div>
  </div>
{/if}
