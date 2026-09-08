<script lang="ts">
  /**
   * The post-composer assist panel's own content, rendered inside
   * `panel-frame.svelte` (#311's chrome) by `linkedin-post-assist.ts`, which
   * owns every state transition and API call - this component only renders
   * `state` and calls back out through its props. Mirrors
   * `linkedin-comment-assist-panel.svelte` (#314) exactly in shape, down to
   * the `reasoning`/`draft` split (#382, see that component's own doc
   * comment); only the strings differ, since this offers a post rather than
   * a comment and has no post author to show as a `subject` (the suggestion
   * is the operator's own voice, not a reply to anyone).
   *
   * That mirroring includes D17 (2026-09-08): the reasoning renders in full
   * while the stream is open and collapses behind one line once a draft
   * exists. Two panels in one product presenting the same two-part answer
   * differently is drift, so this file changes whenever that one does.
   */
  import PanelFrame from './panel-frame.svelte';
  import { t } from '../lib/i18n/index.js';
  import type { PostAssistPanelProps } from './linkedin-post-assist.js';

  // `assistState`, not `state`: a local named `state` makes `$state(...)`
  // below parse as a store subscription of it (see the comment panel).
  let {
    state: assistState,
    onRequest,
    onEditChange,
    onAccept,
    onDismiss,
  }: PostAssistPanelProps = $props();

  /** Whether the collapsed reasoning is open (D17). */
  let whyOpen = $state(false);

  function onTextareaInput(event: Event): void {
    onEditChange((event.currentTarget as HTMLTextAreaElement).value);
  }
</script>

<PanelFrame onclose={onDismiss}>
  {#snippet children()}
    <div class="assist">
      {#if assistState.phase === 'resting'}
        <p class="assist-hint">{$t('assist.post.resting.hint')}</p>
        <div class="assist-row">
          <button type="button" class="assist-button" onclick={onRequest}>
            {$t('assist.post.resting.cta')}
          </button>
        </div>
      {:else if assistState.phase === 'streaming'}
        <p class="assist-status" aria-live="polite">
          {$t(assistState.status === 'reading' ? 'assist.status.reading' : 'assist.status.writing')}
        </p>
        {#if assistState.reasoning}
          <p class="assist-hint">{assistState.reasoning}</p>
        {/if}
        {#if assistState.draft}
          <p class="assist-preview">{assistState.draft}</p>
        {:else}
          <div class="assist-skeleton" aria-hidden="true">
            <span></span>
            <span></span>
            <span></span>
          </div>
        {/if}
      {:else if assistState.phase === 'ready' || assistState.phase === 'edited'}
        <!-- Draft first, reasoning folded under it (D17). -->
        <textarea
          class="assist-textarea"
          aria-label={$t('assist.post.ready.label')}
          value={assistState.draft}
          oninput={onTextareaInput}
        ></textarea>
        <div class="assist-row">
          <button type="button" class="assist-button" onclick={onAccept}>
            {$t('assist.action.accept')}
          </button>
        </div>
        {#if assistState.reasoning}
          <button
            type="button"
            class="assist-why"
            aria-expanded={whyOpen}
            aria-controls="pitchbox-post-why"
            onclick={() => (whyOpen = !whyOpen)}
          >
            <span class="assist-why-caret" aria-hidden="true"></span>
            {$t('assist.comment.why')}
          </button>
          {#if whyOpen}
            <p class="assist-why-body" id="pitchbox-post-why">{assistState.reasoning}</p>
          {/if}
        {/if}
      {:else if assistState.phase === 'accepting'}
        <p class="assist-status" aria-live="polite">{$t('assist.post.accepting')}</p>
      {:else if assistState.phase === 'inserted'}
        <p class="assist-title">{$t('assist.post.inserted.title')}</p>
        <p class="assist-hint">{$t('assist.post.inserted.hint')}</p>
      {:else if assistState.phase === 'no_draft'}
        <!-- The product's own line, never the model's prose (D18). -->
        <p class="assist-title" aria-live="polite">
          {$t(
            assistState.skipped ? 'assist.post.no_draft.skipped' : 'assist.post.no_draft.unstructured',
          )}
        </p>
        <div class="assist-row">
          <button type="button" class="assist-button assist-button--ghost" onclick={onRequest}>
            {$t('assist.action.retry')}
          </button>
        </div>
        {#if assistState.reasoning}
          <button
            type="button"
            class="assist-why"
            aria-expanded={whyOpen}
            aria-controls="pitchbox-post-why-no-draft"
            onclick={() => (whyOpen = !whyOpen)}
          >
            <span class="assist-why-caret" aria-hidden="true"></span>
            {$t('assist.comment.why_skipped')}
          </button>
          {#if whyOpen}
            <p class="assist-why-body" id="pitchbox-post-why-no-draft">{assistState.reasoning}</p>
          {/if}
        {/if}
      {:else if assistState.phase === 'refused'}
        <p class="assist-refusal" role="alert">{$t(assistState.messageKey, assistState.messageParams)}</p>
        <div class="assist-row">
          <button type="button" class="assist-button assist-button--ghost" onclick={onRequest}>
            {$t('assist.action.retry')}
          </button>
        </div>
      {/if}
    </div>
  {/snippet}
</PanelFrame>
