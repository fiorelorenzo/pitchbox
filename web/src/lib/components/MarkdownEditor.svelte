<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { Editor } from 'bytemd';
  import gfm from '@bytemd/plugin-gfm';
  import 'bytemd/dist/index.css';

  type Props = { value: string; onchange: (v: string) => void; height?: string };
  let { value, onchange, height = '420px' }: Props = $props();

  let host: HTMLDivElement | null = null;
  let editor: Editor | null = null;

  onMount(() => {
    if (!host) return;
    editor = new Editor({
      target: host,
      props: { value, mode: 'split', plugins: [gfm()] },
    });
    editor.$on('change', (e: CustomEvent<{ value: string }>) => {
      onchange(e.detail.value);
    });
  });

  onDestroy(() => {
    editor?.$destroy();
    editor = null;
  });

  $effect(() => {
    if (editor) editor.$set({ value });
  });
</script>

<div bind:this={host} style="height: {height}"></div>
