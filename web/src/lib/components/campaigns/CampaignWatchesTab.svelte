<script lang="ts">
  import { invalidateAll } from '$app/navigation';
  import { toast } from 'svelte-sonner';
  import { Radar, Plus, Pencil, Trash2, AlertTriangle } from '@lucide/svelte';
  import EmptyState from '$lib/components/EmptyState.svelte';
  import StatusBadge from '$lib/components/StatusBadge.svelte';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { SelectField } from '$lib/components/ui/select-field';
  import { Checkbox } from '$lib/components/ui/checkbox';
  import * as Card from '$lib/components/ui/card';
  import * as Table from '$lib/components/ui/table';
  import * as Dialog from '$lib/components/ui/dialog';
  import * as AlertDialog from '$lib/components/ui/alert-dialog';
  import { relativeTime } from '$lib/utils/time';
  import { TONE_BANNER_CLASS } from '$lib/config/status-badges';

  type MatchField = 'title' | 'selftext' | 'comment';

  type Watch = {
    id: number;
    subreddit: string;
    pattern: string;
    matchField: MatchField;
    isActive: boolean;
    lastSeenAt: string | null;
    cooldownMinutes: number;
    consecutiveFailures: number;
    nextAttemptAfter: string | null;
    createdAt: string;
  };

  type Props = { campaignId: number; watches: Watch[] };
  let { campaignId, watches }: Props = $props();

  const MATCH_FIELD_OPTIONS: { value: MatchField; label: string }[] = [
    { value: 'title', label: 'Post title' },
    { value: 'selftext', label: 'Post body' },
    { value: 'comment', label: 'Comment body' },
  ];

  // Mirrors the zod schemas in api/campaigns/[id]/keyword-watches/+server.ts
  // so the form can't submit something the API would reject.
  const SUBREDDIT_RE = /^[A-Za-z0-9_]+$/;
  const MAX_SUBREDDIT_LEN = 64;
  const MAX_PATTERN_LEN = 500;
  const MAX_COOLDOWN_MIN = 24 * 60;

  function watchStatus(w: Watch): 'active' | 'paused' | 'backing_off' {
    if (!w.isActive) return 'paused';
    if (w.nextAttemptAfter) return 'backing_off';
    return 'active';
  }

  type FormState = {
    subreddit: string;
    pattern: string;
    matchField: MatchField;
    cooldownMinutes: number;
    isActive: boolean;
  };
  function emptyForm(): FormState {
    return { subreddit: '', pattern: '', matchField: 'title', cooldownMinutes: 30, isActive: true };
  }

  let formOpen = $state(false);
  let editingId = $state<number | null>(null);
  let form = $state<FormState>(emptyForm());
  let saving = $state(false);
  let formError = $state<string | null>(null);

  function openCreate() {
    editingId = null;
    form = emptyForm();
    formError = null;
    formOpen = true;
  }

  function openEdit(w: Watch) {
    editingId = w.id;
    form = {
      subreddit: w.subreddit,
      pattern: w.pattern,
      matchField: w.matchField,
      cooldownMinutes: w.cooldownMinutes,
      isActive: w.isActive,
    };
    formError = null;
    formOpen = true;
  }

  function validate(): string | null {
    if (editingId === null) {
      const subreddit = form.subreddit.trim();
      if (!subreddit) return 'Subreddit is required';
      if (subreddit.length > MAX_SUBREDDIT_LEN) {
        return `Subreddit must be ${MAX_SUBREDDIT_LEN} characters or fewer`;
      }
      if (!SUBREDDIT_RE.test(subreddit)) {
        return 'Subreddit can only contain letters, numbers and underscores (no r/ prefix)';
      }
    }
    const pattern = form.pattern.trim();
    if (!pattern) return 'Pattern is required';
    if (pattern.length > MAX_PATTERN_LEN) return `Pattern must be ${MAX_PATTERN_LEN} characters or fewer`;
    if (
      !Number.isInteger(form.cooldownMinutes) ||
      form.cooldownMinutes < 1 ||
      form.cooldownMinutes > MAX_COOLDOWN_MIN
    ) {
      return `Cooldown must be a whole number of minutes between 1 and ${MAX_COOLDOWN_MIN}`;
    }
    return null;
  }

  async function submitForm() {
    const validationError = validate();
    if (validationError) {
      toast.error(validationError);
      return;
    }
    const isEdit = editingId !== null;
    saving = true;
    formError = null;
    try {
      const res = await fetch(`/api/campaigns/${campaignId}/keyword-watches`, {
        method: isEdit ? 'PATCH' : 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(
          isEdit
            ? {
                watchId: editingId,
                pattern: form.pattern.trim(),
                matchField: form.matchField,
                cooldownMinutes: form.cooldownMinutes,
                isActive: form.isActive,
              }
            : {
                subreddit: form.subreddit.trim(),
                pattern: form.pattern.trim(),
                matchField: form.matchField,
                cooldownMinutes: form.cooldownMinutes,
                isActive: form.isActive,
              },
        ),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
        const action = isEdit ? 'update' : 'create';
        const message =
          res.status >= 500
            ? `Could not ${action} the keyword watch. Please try again.`
            : (body.error ?? body.message ?? `Could not ${action} the keyword watch.`);
        if (res.status >= 500) {
          console.error('failed to save keyword watch', campaignId, res.status, body);
        }
        formError = message;
        toast.error(message);
        return;
      }
      toast.success(isEdit ? 'Keyword watch updated' : 'Keyword watch created');
      formOpen = false;
      await invalidateAll();
    } catch {
      const message = 'Could not save the keyword watch, check your connection.';
      formError = message;
      toast.error(message);
    } finally {
      saving = false;
    }
  }

  let deleteTarget = $state<Watch | null>(null);
  let deleteOpen = $state(false);
  let deleting = $state(false);
  let deleteError = $state<string | null>(null);

  function openDelete(w: Watch) {
    deleteTarget = w;
    deleteError = null;
    deleteOpen = true;
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    deleting = true;
    deleteError = null;
    try {
      const res = await fetch(
        `/api/campaigns/${campaignId}/keyword-watches?watchId=${deleteTarget.id}`,
        { method: 'DELETE' },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
        const message =
          res.status >= 500
            ? 'Could not delete the keyword watch. Please try again.'
            : (body.error ?? body.message ?? 'Could not delete the keyword watch.');
        if (res.status >= 500) {
          console.error('failed to delete keyword watch', campaignId, res.status, body);
        }
        deleteError = message;
        toast.error(message);
        return;
      }
      toast.success('Keyword watch deleted');
      deleteOpen = false;
      deleteTarget = null;
      await invalidateAll();
    } catch {
      const message = 'Could not delete the keyword watch, check your connection.';
      deleteError = message;
      toast.error(message);
    } finally {
      deleting = false;
    }
  }
</script>

<div class="space-y-4">
  <div class="flex items-start justify-between gap-4">
    <p class="text-sm text-muted-foreground max-w-2xl">
      A keyword watch polls a subreddit for new posts and starts this campaign automatically the
      moment one matches, instead of waiting on the cron schedule.
    </p>
    <Button size="sm" onclick={openCreate}>
      <Plus class="size-4" />
      New watch
    </Button>
  </div>

  {#if watches.length === 0}
    <Card.Root size="sm">
      <Card.Content>
        <EmptyState
          icon={Radar}
          title="No keyword watches yet"
          description="A keyword watch polls a subreddit's newest posts every few minutes for one matching a pattern you set, in the post title, post body, or a comment. The first match starts a run of this campaign, then the watch cools down before it can fire again."
        >
          <Button size="sm" onclick={openCreate}>
            <Plus class="size-4" />
            New watch
          </Button>
        </EmptyState>
      </Card.Content>
    </Card.Root>
  {:else}
    <Card.Root size="sm">
      <Card.Content>
        <Table.Root>
          <Table.Header>
            <Table.Row>
              <Table.Head>Subreddit</Table.Head>
              <Table.Head>Watching for</Table.Head>
              <Table.Head>Status</Table.Head>
              <Table.Head>Cooldown</Table.Head>
              <Table.Head>Last match</Table.Head>
              <Table.Head class="w-20"></Table.Head>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {#each watches as w (w.id)}
              <Table.Row>
                <Table.Cell class="font-mono text-xs">r/{w.subreddit}</Table.Cell>
                <Table.Cell class="max-w-[20rem]">
                  <div class="flex flex-col gap-0.5">
                    <span class="font-mono text-xs truncate" title={w.pattern}>{w.pattern}</span>
                    <span class="text-[10px] text-muted-foreground">
                      {MATCH_FIELD_OPTIONS.find((o) => o.value === w.matchField)?.label ?? w.matchField}
                    </span>
                  </div>
                </Table.Cell>
                <Table.Cell>
                  <StatusBadge
                    domain="keyword-watch-status"
                    value={watchStatus(w)}
                    class={watchStatus(w) === 'backing_off' ? 'cursor-help' : undefined}
                  />
                  {#if watchStatus(w) === 'backing_off'}
                    <div class="text-[10px] text-muted-foreground mt-0.5">
                      {w.consecutiveFailures} failed fetches in a row
                    </div>
                  {/if}
                </Table.Cell>
                <Table.Cell class="text-xs text-muted-foreground">{w.cooldownMinutes}m</Table.Cell>
                <Table.Cell class="text-xs text-muted-foreground" title={w.lastSeenAt ?? undefined}>
                  {w.lastSeenAt ? relativeTime(w.lastSeenAt) : 'Never'}
                </Table.Cell>
                <Table.Cell>
                  <div class="flex justify-end gap-1">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Edit watch"
                      onclick={() => openEdit(w)}
                      class="text-muted-foreground hover:text-foreground"
                    >
                      <Pencil class="size-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Delete watch"
                      onclick={() => openDelete(w)}
                      class="text-muted-foreground hover:text-destructive"
                    >
                      <Trash2 class="size-3.5" />
                    </Button>
                  </div>
                </Table.Cell>
              </Table.Row>
            {/each}
          </Table.Body>
        </Table.Root>
      </Card.Content>
    </Card.Root>
  {/if}
</div>

<Dialog.Root open={formOpen} onOpenChange={(v) => (formOpen = v)}>
  <Dialog.Content class="sm:max-w-lg">
    <Dialog.Header>
      <Dialog.Title>{editingId === null ? 'New keyword watch' : 'Edit keyword watch'}</Dialog.Title>
      <Dialog.Description>
        {editingId === null
          ? 'Poll a subreddit and dispatch this campaign the moment a post or comment matches.'
          : 'Subreddit cannot be changed after creation. Delete this watch and create a new one to target a different subreddit.'}
      </Dialog.Description>
    </Dialog.Header>

    {#if formError}
      <div role="alert" class="flex items-start gap-2 rounded-lg border px-3 py-2 text-xs {TONE_BANNER_CLASS.rose}">
        <AlertTriangle class="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
        <span class="flex-1">{formError}</span>
      </div>
    {/if}

    <div class="space-y-3">
      <div>
        <label class="text-sm font-medium block mb-1" for="watch-subreddit">Subreddit</label>
        <Input
          id="watch-subreddit"
          bind:value={form.subreddit}
          placeholder="askreddit"
          maxlength={MAX_SUBREDDIT_LEN}
          disabled={editingId !== null || saving}
        />
        <p class="text-xs text-muted-foreground mt-1">
          No r/ prefix. Letters, numbers and underscores only.
        </p>
      </div>
      <div>
        <label class="text-sm font-medium block mb-1" for="watch-pattern">Pattern</label>
        <Input
          id="watch-pattern"
          bind:value={form.pattern}
          placeholder="looking for feedback"
          maxlength={MAX_PATTERN_LEN}
          disabled={saving}
        />
        <p class="text-xs text-muted-foreground mt-1">
          Case-insensitive substring match. Wrap in /slashes/ for a regex, e.g. /\bfeedback\b/i.
        </p>
      </div>
      <div class="grid grid-cols-2 gap-3">
        <div>
          <label class="text-sm font-medium block mb-1" for="watch-match-field">Match against</label>
          <SelectField
            id="watch-match-field"
            bind:value={form.matchField}
            options={MATCH_FIELD_OPTIONS}
            disabled={saving}
            fullWidth
          />
        </div>
        <div>
          <label class="text-sm font-medium block mb-1" for="watch-cooldown">Cooldown (minutes)</label>
          <Input
            id="watch-cooldown"
            type="number"
            min={1}
            max={MAX_COOLDOWN_MIN}
            bind:value={form.cooldownMinutes}
            disabled={saving}
          />
        </div>
      </div>
      <label class="flex items-center gap-2 text-sm">
        <Checkbox bind:checked={form.isActive} disabled={saving} />
        Active
      </label>
      <p class="text-xs text-muted-foreground">
        Inactive watches stay configured but the daemon skips them until reactivated.
      </p>
    </div>

    <Dialog.Footer>
      <Button variant="ghost" onclick={() => (formOpen = false)} disabled={saving}>Cancel</Button>
      <Button onclick={submitForm} loading={saving}>
        {editingId === null ? 'Create' : 'Save'}
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>

<AlertDialog.Root bind:open={deleteOpen}>
  <AlertDialog.Content>
    <AlertDialog.Header>
      <AlertDialog.Title>
        Delete the watch for "{deleteTarget?.pattern ?? ''}"?
      </AlertDialog.Title>
      <AlertDialog.Description>
        Pitchbox will stop polling r/{deleteTarget?.subreddit ?? ''} for this pattern. You can
        recreate the watch later if you need it again.
      </AlertDialog.Description>
    </AlertDialog.Header>
    {#if deleteError}
      <div role="alert" class="flex items-start gap-2 rounded-lg border px-3 py-2 text-xs {TONE_BANNER_CLASS.rose}">
        <AlertTriangle class="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
        <span class="flex-1">{deleteError}</span>
      </div>
    {/if}
    <AlertDialog.Footer>
      <AlertDialog.Cancel onclick={() => (deleteOpen = false)}>
        Cancel
      </AlertDialog.Cancel>
      <AlertDialog.Action onclick={confirmDelete} disabled={deleting}>
        {deleting ? 'Deleting…' : 'Delete'}
      </AlertDialog.Action>
    </AlertDialog.Footer>
  </AlertDialog.Content>
</AlertDialog.Root>
