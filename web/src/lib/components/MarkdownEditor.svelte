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

<div style="height: {height}">
  <Editor {value} {plugins} mode="split" on:change={handleChange} />
</div>
