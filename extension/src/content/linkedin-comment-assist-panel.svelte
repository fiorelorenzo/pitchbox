<script lang="ts">
  /**
   * The comment-assist panel's own content, rendered inside `panel-frame.svelte`
   * (#311's chrome) by `linkedin-comment-assist.ts`, which owns every state
   * transition and API call - this component only renders `state` and calls
   * back out through its props. See `docs/design/linkedin-assistant-brief.md`
   * for the states this renders (resting, streaming, ready, edited, inserted,
   * refused) and D3 (docs/design/DECISIONS.md) for why streaming shows a
   * skeleton plus a status line rather than a bare spinner.
   *
   * `reasoning` and `draft` (#382) never share a control, and since D17
   * (2026-09-08) they do not share prominence either: while the stream is
   * open the reasoning renders in full in `.assist-hint` (it arrives first
   * and it is what the human reads during the wait), and the moment a draft
   * exists it collapses behind one line (`.assist-why`) that can be
   * expanded. The draft is primary throughout, in `.assist-preview` while
   * streaming and `.assist-textarea` once editable, at the same size in
   * both so the text does not resize under the reader. Only `assistState.draft`
   * ever reaches `onAccept`; `no_draft` renders no accept control at all,
   * and says so in the product's own voice rather than printing the
   * model's (D18).
   */
  import PanelFrame from './panel-frame.svelte';
  import { t } from '../lib/i18n/index.js';
  import type { CommentAssistPanelProps } from './linkedin-comment-assist.js';

  // Destructured as `assistState`, not `state`: a local named `state`
  // makes `$state(...)` below parse as a store subscription of it
  // (`store_invalid_shape` at runtime, and the panel never mounts).
  let {
    subject,
    state: assistState,
    onRequest,
    onEditChange,
    onAccept,
    onDismiss,
  }: CommentAssistPanelProps = $props();

  /** Whether the collapsed reasoning is open (D17). Component state, not a
   * `<details>` element's own: the panel re-renders on every stream chunk
   * and on every keystroke in the draft, and an open disclosure has to
   * survive both. Starts closed, per phase - a fresh suggestion is a fresh
   * decision about whether the reasoning is worth reading. */
  let whyOpen = $state(false);

  function onTextareaInput(event: Event): void {
    onEditChange((event.currentTarget as HTMLTextAreaElement).value);
  }
</script>

<PanelFrame {subject} onclose={onDismiss}>
  {#snippet children()}
    <div class="assist">
      {#if assistState.phase === 'resting'}
        <p class="assist-hint">{$t('assist.comment.resting.hint')}</p>
        <div class="assist-row">
          <button type="button" class="assist-button" onclick={onRequest}>
            {$t('assist.comment.resting.cta')}
          </button>
        </div>
      {:else if assistState.phase === 'streaming'}
        <p class="assist-status" aria-live="polite">
          {$t(assistState.status === 'reading' ? 'assist.status.reading' : 'assist.status.writing')}
        </p>
        <!-- While the stream is open the reasoning is the whole point of
             showing anything: it arrives before the draft does and it is
             what makes a 20-30 second wait tolerable (D17). -->
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
        <!-- Draft first, reasoning collapsed underneath (D17): the draft is
             what the human came for, and the reasoning has already been read
             during the wait. -->
        <textarea
          class="assist-textarea"
          aria-label={$t('assist.comment.ready.label')}
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
            aria-controls="pitchbox-why"
            onclick={() => (whyOpen = !whyOpen)}
          >
            <span class="assist-why-caret" aria-hidden="true"></span>
            {$t('assist.comment.why')}
          </button>
          {#if whyOpen}
            <p class="assist-why-body" id="pitchbox-why">{assistState.reasoning}</p>
          {/if}
        {/if}
      {:else if assistState.phase === 'accepting'}
        <p class="assist-status" aria-live="polite">{$t('assist.comment.accepting')}</p>
      {:else if assistState.phase === 'inserted'}
        <p class="assist-title">{$t('assist.comment.inserted.title')}</p>
        <p class="assist-hint">{$t('assist.comment.inserted.hint')}</p>
      {:else if assistState.phase === 'no_draft'}
        <!-- The product's own two lines, never the model's prose (D18). A
             deliberate decline and a malformed answer read differently: one
             is the tool working, the other is our own bug. The model's
             reasoning is still available, in the same collapsed place it
             lives behind a draft. -->
        <p class="assist-title" aria-live="polite">
          {$t(
            assistState.skipped
              ? 'assist.comment.no_draft.skipped.title'
              : 'assist.comment.no_draft.malformed.title',
          )}
        </p>
        <p class="assist-hint">
          {$t(
            assistState.skipped
              ? 'assist.comment.no_draft.skipped.hint'
              : 'assist.comment.no_draft.malformed.hint',
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
            aria-controls="pitchbox-why-no-draft"
            onclick={() => (whyOpen = !whyOpen)}
          >
            <span class="assist-why-caret" aria-hidden="true"></span>
            {$t('assist.comment.why_skipped')}
          </button>
          {#if whyOpen}
            <p class="assist-why-body" id="pitchbox-why-no-draft">{assistState.reasoning}</p>
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
