<script lang="ts">
  import { page } from '$app/stores';
  import { invalidateAll } from '$app/navigation';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { SelectField } from '$lib/components/ui/select-field';
  import * as AlertDialog from '$lib/components/ui/alert-dialog';
  import { toast } from 'svelte-sonner';
  import { t, type Locale } from '$lib/i18n/index.js';

  type Template = {
    id: number;
    kind: string;
    title: string;
    body: string;
    isActive: boolean;
    createdAt: string | Date;
  };
  type Props = { projectId: number; templates: Template[]; isAdmin: boolean };
  let { projectId, templates, isAdmin }: Props = $props();

  const locale = $derived($page.data.locale as Locale);

  let addOpen = $state(false);
  let newKind = $state<'dm' | 'comment' | 'post'>('comment');
  let newTitle = $state('');
  let newBody = $state('');
  let busy = $state(false);

  const kindOptions = $derived([
    { value: 'dm', label: t(locale, 'projects.template-kind.dm') },
    { value: 'comment', label: t(locale, 'projects.template-kind.comment') },
    { value: 'post', label: t(locale, 'projects.template-kind.post') },
  ]);

  async function add() {
    if (!newTitle.trim() || !newBody.trim()) {
      toast.error(t(locale, 'projects.error-template-fields-required'));
      return;
    }
    busy = true;
    try {
      const res = await fetch(`/api/projects/${projectId}/templates`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: newKind, title: newTitle, body: newBody }),
      });
      if (!res.ok) {
        toast.error(t(locale, 'projects.error-template-create-failed'));
        return;
      }
      newTitle = '';
      newBody = '';
      addOpen = false;
      await invalidateAll();
    } finally {
      busy = false;
    }
  }

  async function toggleActive(tpl: Template) {
    const res = await fetch(`/api/projects/${projectId}/templates/${tpl.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ isActive: !tpl.isActive }),
    });
    if (!res.ok) toast.error(t(locale, 'projects.error-update-failed'));
    else await invalidateAll();
  }

  let deleteDialogOpen = $state(false);
  let deleteTarget = $state<Template | null>(null);
  let deleting = $state(false);

  function openDeleteDialog(tpl: Template) {
    deleteTarget = tpl;
    deleteDialogOpen = true;
  }

  async function confirmRemove() {
    if (!deleteTarget) return;
    deleting = true;
    try {
      const res = await fetch(`/api/projects/${projectId}/templates/${deleteTarget.id}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        toast.error(
          res.status === 403
            ? t(locale, 'projects.error-admin-required')
            : t(locale, 'projects.error-delete-failed'),
        );
        return;
      }
      deleteDialogOpen = false;
      deleteTarget = null;
      await invalidateAll();
    } finally {
      deleting = false;
    }
  }
</script>

<div class="flex items-center justify-between mb-4">
  <p class="text-sm text-muted-foreground">
    {t(locale, 'projects.templates-intro')}
  </p>
  <Button onclick={() => (addOpen = !addOpen)}
    >{addOpen ? t(locale, 'projects.cancel-button') : t(locale, 'projects.new-template-button')}</Button
  >
</div>

{#if addOpen}
  <div class="border border-border rounded p-4 mb-4 space-y-3">
    <div class="grid grid-cols-2 gap-3">
      <div>
        <label class="text-sm font-medium block mb-1" for="tpl-kind"
          >{t(locale, 'projects.template-kind-label')}</label
        >
        <SelectField id="tpl-kind" bind:value={newKind} options={kindOptions} fullWidth />
      </div>
      <div>
        <label class="text-sm font-medium block mb-1" for="tpl-title"
          >{t(locale, 'projects.template-title-label')}</label
        >
        <Input
          id="tpl-title"
          bind:value={newTitle}
          placeholder={t(locale, 'projects.template-title-placeholder')}
        />
      </div>
    </div>
    <div>
      <label class="text-sm font-medium block mb-1" for="tpl-body"
        >{t(locale, 'projects.template-body-label')}</label
      >
      <textarea
        id="tpl-body"
        bind:value={newBody}
        rows="6"
        class="w-full rounded border border-input bg-background px-3 py-2 text-sm"
        placeholder={t(locale, 'projects.template-body-placeholder')}
      ></textarea>
    </div>
    <Button onclick={add} disabled={busy}>{t(locale, 'projects.save-button')}</Button>
  </div>
{/if}

{#if templates.length === 0}
  <p class="text-sm text-muted-foreground">{t(locale, 'projects.templates-empty')}</p>
{:else}
  <div class="space-y-2">
    {#each templates as tpl (tpl.id)}
      <div class="border border-border rounded p-3">
        <div class="flex items-center justify-between mb-1">
          <div class="flex items-center gap-2">
            <span class="text-xs uppercase px-2 py-0.5 rounded bg-muted">{tpl.kind}</span>
            <span class="font-medium">{tpl.title}</span>
            {#if !tpl.isActive}
              <span class="text-xs text-muted-foreground">{t(locale, 'projects.template-archived-badge')}</span>
            {/if}
          </div>
          <div class="flex gap-2">
            <Button variant="outline" size="sm" onclick={() => toggleActive(tpl)}>
              {tpl.isActive ? t(locale, 'projects.archive-button') : t(locale, 'projects.restore-button')}
            </Button>
            {#if isAdmin}
              <Button variant="outline" size="sm" onclick={() => openDeleteDialog(tpl)}
                >{t(locale, 'projects.delete-button')}</Button
              >
            {/if}
          </div>
        </div>
        <pre class="text-sm whitespace-pre-wrap text-muted-foreground">{tpl.body}</pre>
      </div>
    {/each}
  </div>
{/if}

<AlertDialog.Root bind:open={deleteDialogOpen}>
  <AlertDialog.Content>
    <AlertDialog.Header>
      <AlertDialog.Title
        >{t(locale, 'projects.delete-template-title', { title: deleteTarget?.title ?? '' })}</AlertDialog.Title
      >
      <AlertDialog.Description>
        {t(locale, 'projects.delete-template-body')}
      </AlertDialog.Description>
    </AlertDialog.Header>
    <AlertDialog.Footer>
      <AlertDialog.Cancel onclick={() => (deleteDialogOpen = false)}
        >{t(locale, 'projects.cancel-button')}</AlertDialog.Cancel
      >
      <AlertDialog.Action onclick={confirmRemove} disabled={deleting}>
        {deleting ? t(locale, 'projects.deleting-button') : t(locale, 'projects.delete-template-button')}
      </AlertDialog.Action>
    </AlertDialog.Footer>
  </AlertDialog.Content>
</AlertDialog.Root>
