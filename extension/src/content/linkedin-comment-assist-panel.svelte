<script lang="ts">
  /**
   * The comment-assist panel's own content, rendered inside `panel-frame.svelte`
   * (#311's chrome) by `linkedin-comment-assist.ts`, which owns every state
   * transition and API call - this component only renders `state` and calls
   * back out through its props. See `docs/design/linkedin-assistant-brief.md`
   * for the states this renders (resting, streaming, ready, edited, inserted,
   * refused) and D3 (docs/design/DECISIONS.md) for why streaming shows a
   * skeleton plus a status line rather than a bare spinner.
   */
  import PanelFrame from './panel-frame.svelte';
  import { t } from '../lib/i18n/index.js';
  import type { CommentAssistPanelProps } from './linkedin-comment-assist.js';

  let { subject, state, onRequest, onEditChange, onAccept, onDismiss }: CommentAssistPanelProps =
    $props();

  function onTextareaInput(event: Event): void {
    onEditChange((event.currentTarget as HTMLTextAreaElement).value);
  }
</script>

<PanelFrame {subject} onclose={onDismiss}>
  {#snippet children()}
    <div class="assist">
      {#if state.phase === 'resting'}
        <p class="assist-hint">{$t('assist.comment.resting.hint')}</p>
        <div class="assist-row">
          <button type="button" class="assist-button" onclick={onRequest}>
            {$t('assist.comment.resting.cta')}
          </button>
        </div>
      {:else if state.phase === 'streaming'}
        <p class="assist-status" aria-live="polite">
          {$t(state.status === 'reading' ? 'assist.status.reading' : 'assist.status.writing')}
        </p>
        {#if state.text}
          <p class="assist-preview">{state.text}</p>
        {:else}
          <div class="assist-skeleton" aria-hidden="true">
            <span></span>
            <span></span>
            <span></span>
          </div>
        {/if}
      {:else if state.phase === 'ready' || state.phase === 'edited'}
        <textarea
          class="assist-textarea"
          aria-label={$t('assist.comment.ready.label')}
          value={state.text}
          oninput={onTextareaInput}
        ></textarea>
        <div class="assist-row">
          <button type="button" class="assist-button" onclick={onAccept}>
            {$t('assist.action.accept')}
          </button>
        </div>
      {:else if state.phase === 'accepting'}
        <p class="assist-status" aria-live="polite">{$t('assist.comment.accepting')}</p>
      {:else if state.phase === 'inserted'}
        <p class="assist-status">{$t('assist.comment.inserted.title')}</p>
        <p class="assist-hint">{$t('assist.comment.inserted.hint')}</p>
      {:else if state.phase === 'refused'}
        <p class="assist-refusal" role="alert">{$t(state.messageKey, state.messageParams)}</p>
        <div class="assist-row">
          <button type="button" class="assist-button assist-button--ghost" onclick={onRequest}>
            {$t('assist.action.retry')}
          </button>
        </div>
      {/if}
    </div>
  {/snippet}
</PanelFrame>
