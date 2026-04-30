<script lang="ts">
  import { Editor } from 'bytemd';
  import gfm from '@bytemd/plugin-gfm';
  import 'bytemd/dist/index.css';

  type Props = { value: string; onchange: (v: string) => void; height?: string };
  let { value, onchange, height = '420px' }: Props = $props();

  const plugins = [gfm()];

  function handleChange(e: CustomEvent<{ value: string }>) {
    onchange(e.detail.value);
  }
</script>

<div class="md-host" style="height: {height}">
  <Editor {value} {plugins} mode="split" on:change={handleChange} />
</div>

<style>
  .md-host :global(.bytemd) {
    height: 100%;
    border: 1px solid var(--border);
    border-radius: var(--radius, 0.5rem);
    background: var(--background);
    color: var(--foreground);
    font-family: inherit;
  }

  .md-host :global(.bytemd-toolbar) {
    background: var(--muted);
    border-bottom: 1px solid var(--border);
    color: var(--foreground);
  }

  .md-host :global(.bytemd-toolbar-icon) {
    color: var(--muted-foreground);
  }
  .md-host :global(.bytemd-toolbar-icon:hover),
  .md-host :global(.bytemd-toolbar-icon-active) {
    background: var(--accent, var(--muted));
    color: var(--foreground);
  }

  .md-host :global(.bytemd-toolbar-tab) {
    color: var(--muted-foreground);
  }
  .md-host :global(.bytemd-toolbar-tab-active) {
    color: var(--foreground);
    border-bottom-color: var(--foreground);
  }

  .md-host :global(.bytemd-body) {
    background: var(--background);
  }

  .md-host :global(.bytemd-editor),
  .md-host :global(.bytemd-preview) {
    background: var(--background);
    color: var(--foreground);
    border-color: var(--border);
  }

  .md-host :global(.bytemd-split .bytemd-preview) {
    border-left: 1px solid var(--border);
  }

  .md-host :global(.CodeMirror) {
    background: var(--background) !important;
    color: var(--foreground) !important;
    font-family:
      ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New',
      monospace;
    font-size: 13px;
    line-height: 1.6;
  }

  .md-host :global(.CodeMirror-gutters) {
    background: var(--muted) !important;
    border-right: 1px solid var(--border) !important;
  }

  .md-host :global(.CodeMirror-linenumber) {
    color: var(--muted-foreground) !important;
  }

  .md-host :global(.CodeMirror-cursor) {
    border-left-color: var(--foreground) !important;
  }

  .md-host :global(.CodeMirror-selected) {
    background: var(--muted) !important;
  }

  .md-host :global(.bytemd-preview .markdown-body) {
    background: var(--background);
    color: var(--foreground);
    padding: 1rem;
  }

  .md-host :global(.bytemd-preview .markdown-body a) {
    color: var(--primary);
  }

  .md-host :global(.bytemd-preview .markdown-body code),
  .md-host :global(.bytemd-preview .markdown-body pre) {
    background: var(--muted);
    color: var(--foreground);
    border-radius: 0.25rem;
  }

  .md-host :global(.bytemd-preview .markdown-body blockquote) {
    border-left-color: var(--border);
    color: var(--muted-foreground);
  }

  .md-host :global(.bytemd-preview .markdown-body hr) {
    background: var(--border);
  }

  .md-host :global(.bytemd-status) {
    background: var(--muted);
    border-top: 1px solid var(--border);
    color: var(--muted-foreground);
  }

  .md-host :global(.bytemd-status-left),
  .md-host :global(.bytemd-status-right) {
    color: var(--muted-foreground);
  }

  .md-host :global(.bytemd-help),
  .md-host :global(.bytemd-toc) {
    background: var(--background);
    color: var(--foreground);
    border-color: var(--border);
  }
</style>
