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

  /* Hide bytemd's GitHub link in the right toolbar (the only <a> there). */
  .md-host :global(.bytemd-toolbar-right a.bytemd-toolbar-icon) {
    display: none !important;
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
    padding: 1.25rem 1.5rem;
    font-size: 14px;
    line-height: 1.65;
  }

  .md-host :global(.bytemd-preview .markdown-body > *:first-child) {
    margin-top: 0 !important;
  }
  .md-host :global(.bytemd-preview .markdown-body > *:last-child) {
    margin-bottom: 0 !important;
  }

  .md-host :global(.bytemd-preview .markdown-body p),
  .md-host :global(.bytemd-preview .markdown-body ul),
  .md-host :global(.bytemd-preview .markdown-body ol),
  .md-host :global(.bytemd-preview .markdown-body blockquote),
  .md-host :global(.bytemd-preview .markdown-body pre),
  .md-host :global(.bytemd-preview .markdown-body table) {
    margin: 0 0 1em 0 !important;
  }

  .md-host :global(.bytemd-preview .markdown-body h1),
  .md-host :global(.bytemd-preview .markdown-body h2),
  .md-host :global(.bytemd-preview .markdown-body h3),
  .md-host :global(.bytemd-preview .markdown-body h4),
  .md-host :global(.bytemd-preview .markdown-body h5),
  .md-host :global(.bytemd-preview .markdown-body h6) {
    margin: 1.6em 0 0.6em 0 !important;
    line-height: 1.3;
    font-weight: 600;
    color: var(--foreground);
    border-bottom: none !important;
    padding-bottom: 0 !important;
  }
  .md-host :global(.bytemd-preview .markdown-body h1) {
    font-size: 1.6em;
  }
  .md-host :global(.bytemd-preview .markdown-body h2) {
    font-size: 1.35em;
  }
  .md-host :global(.bytemd-preview .markdown-body h3) {
    font-size: 1.15em;
  }
  .md-host :global(.bytemd-preview .markdown-body h4) {
    font-size: 1em;
  }

  .md-host :global(.bytemd-preview .markdown-body ul),
  .md-host :global(.bytemd-preview .markdown-body ol) {
    padding-left: 1.5rem !important;
  }
  .md-host :global(.bytemd-preview .markdown-body li + li) {
    margin-top: 0.25em;
  }
  .md-host :global(.bytemd-preview .markdown-body li > p) {
    margin-bottom: 0.4em !important;
  }

  .md-host :global(.bytemd-preview .markdown-body a) {
    color: var(--primary);
    text-decoration: underline;
    text-underline-offset: 2px;
  }

  .md-host :global(.bytemd-preview .markdown-body code) {
    background: var(--muted);
    color: var(--foreground);
    border-radius: 0.25rem;
    padding: 0.1em 0.35em;
    font-size: 0.92em;
  }
  .md-host :global(.bytemd-preview .markdown-body pre) {
    background: var(--muted);
    color: var(--foreground);
    border-radius: 0.375rem;
    padding: 0.85em 1em;
    overflow-x: auto;
  }
  .md-host :global(.bytemd-preview .markdown-body pre code) {
    background: transparent;
    padding: 0;
    font-size: 0.9em;
  }

  .md-host :global(.bytemd-preview .markdown-body blockquote) {
    border-left: 3px solid var(--border);
    color: var(--muted-foreground);
    padding: 0.25em 0 0.25em 1em;
    margin-left: 0;
  }

  .md-host :global(.bytemd-preview .markdown-body hr) {
    height: 1px;
    background: var(--border);
    border: 0;
    margin: 1.5em 0;
  }

  .md-host :global(.bytemd-preview .markdown-body table) {
    border-collapse: collapse;
    display: block;
    overflow-x: auto;
  }
  .md-host :global(.bytemd-preview .markdown-body th),
  .md-host :global(.bytemd-preview .markdown-body td) {
    border: 1px solid var(--border);
    padding: 0.4em 0.7em;
  }
  .md-host :global(.bytemd-preview .markdown-body th) {
    background: var(--muted);
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
