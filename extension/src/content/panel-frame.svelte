<script lang="ts">
  /**
   * The in-page panel's chrome, and nothing else: the frame that
   * `shared/panel-host.ts` mounts into a shadow root, with the assist content
   * rendered into it as a snippet by whoever owns that content (#314, #315).
   *
   * It is deliberately not the assist UI. Keeping the frame separate is what
   * lets the host be verified on its own, and stops this file from
   * pre-deciding controls that belong to a later issue.
   *
   * Per `docs/design/DECISIONS.md` D10 the frame reads as Pitchbox and never
   * as LinkedIn: dark card, one hairline, its own wordmark, no borrowed
   * LinkedIn typography, spacing or control shapes.
   */
  import type { Snippet } from 'svelte';
  import { t } from '../lib/i18n/index.js';

  type Props = {
    /** Rendered in the panel body. Owned by the caller. */
    children?: Snippet;
    /** Shown next to the wordmark. The post's author, usually. */
    subject?: string;
    /** Called when the human dismisses the panel. */
    onclose?: () => void;
  };

  let { children, subject, onclose }: Props = $props();
</script>

<section class="frame" aria-label={$t('panel.title')}>
  <header class="head">
    <span class="mark">{$t('panel.title')}</span>
    {#if subject}
      <span class="subject" title={subject}>{subject}</span>
    {/if}
    {#if onclose}
      <button type="button" class="close" onclick={onclose} aria-label={$t('panel.close')}>
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
          <path
            d="M4 4l8 8M12 4l-8 8"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
          />
        </svg>
      </button>
    {/if}
  </header>
  <div class="body">
    {@render children?.()}
  </div>
</section>

<!--
  No `<style>` block, on purpose. Vite extracts a Svelte component's styles into
  a separate stylesheet loaded by the document, and a document stylesheet cannot
  reach inside a shadow root: the frame would render with its scoped `svelte-*`
  classes present and none of their rules applied. This component's CSS lives in
  `panel.css`, the sheet the host actually adopts into the shadow root. Inside a
  shadow root the boundary already gives the scoping a `<style>` block would.
-->
