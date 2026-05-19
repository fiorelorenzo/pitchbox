<script lang="ts">
  import * as Dialog from '$lib/components/ui/dialog';
  import { Button } from '$lib/components/ui/button';
  import { Textarea } from '$lib/components/ui/textarea';
  import { toast } from 'svelte-sonner';

  type Props = {
    open: boolean;
    onOpenChange: (v: boolean) => void;
    campaignId: number;
    initialObjective?: string;
    onLaunched: (runId: number) => void;
  };
  let { open, onOpenChange, campaignId, initialObjective, onLaunched }: Props = $props();

  // svelte-ignore state_referenced_locally
  let objective = $state(initialObjective ?? '');
  let submitting = $state(false);

  async function submit() {
    if (!objective.trim()) {
      toast.error('Objective is required');
      return;
    }
    submitting = true;
    try {
      const res = await fetch(`/api/campaigns/${campaignId}/skill-runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ objective }),
      });
      const body = await res.json();
      if (res.status === 409) {
        toast.error('A generation is already running');
        return;
      }
      if (!res.ok) {
        toast.error(body.message ?? 'Failed to start generation');
        return;
      }
      toast.success(`Generation run #${body.runId} started`);
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
      <Dialog.Title>Regenerate profile</Dialog.Title>
      <Dialog.Description>
        Describe the campaign objective in natural language. The agent will produce a fresh profile that matches the scenario schema.
      </Dialog.Description>
    </Dialog.Header>
    <Textarea bind:value={objective} rows={6} />
    <Dialog.Footer>
      <Button variant="ghost" onclick={() => onOpenChange(false)} disabled={submitting}>
        Cancel
      </Button>
      <Button onclick={submit} loading={submitting}>Run</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
