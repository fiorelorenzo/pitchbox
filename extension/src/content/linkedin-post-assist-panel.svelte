<script lang="ts">
  /**
   * The post-composer assist panel's own content, rendered inside
   * `panel-frame.svelte` (#311's chrome) by `linkedin-post-assist.ts`, which
   * owns every state transition and API call - this component only renders
   * `state` and calls back out through its props. Mirrors
   * `linkedin-comment-assist-panel.svelte` (#314) exactly in shape; only the
   * strings differ, since this offers a post rather than a comment and has
   * no post author to show as a `subject` (the suggestion is the operator's
   * own voice, not a reply to anyone).
   */
  import PanelFrame from './panel-frame.svelte';
  import { t } from '../lib/i18n/index.js';
  import type { PostAssistPanelProps } from './linkedin-post-assist.js';

  let { state, onRequest, onEditChange, onAccept, onDismiss }: PostAssistPanelProps = $props();

  function onTextareaInput(event: Event): void {
    onEditChange((event.currentTarget as HTMLTextAreaElement).value);
  }
</script>

<PanelFrame onclose={onDismiss}>
  {#snippet children()}
    <div class="assist">
      {#if state.phase === 'resting'}
        <p class="assist-hint">{$t('assist.post.resting.hint')}</p>
        <div class="assist-row">
          <button type="button" class="assist-button" onclick={onRequest}>
            {$t('assist.post.resting.cta')}
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
          aria-label={$t('assist.post.ready.label')}
          value={state.text}
          oninput={onTextareaInput}
        ></textarea>
        <div class="assist-row">
          <button type="button" class="assist-button" onclick={onAccept}>
            {$t('assist.action.accept')}
          </button>
        </div>
      {:else if state.phase === 'accepting'}
        <p class="assist-status" aria-live="polite">{$t('assist.post.accepting')}</p>
      {:else if state.phase === 'inserted'}
        <p class="assist-status">{$t('assist.post.inserted.title')}</p>
        <p class="assist-hint">{$t('assist.post.inserted.hint')}</p>
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
