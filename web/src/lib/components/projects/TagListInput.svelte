<script lang="ts">
  type Props = { value: string[]; placeholder?: string };
  let { value = $bindable(), placeholder = 'Add and press Enter' }: Props = $props();
  let draft = $state('');

  function add() {
    const v = draft.trim();
    if (!v) return;
    if (!value.includes(v)) value = [...value, v];
    draft = '';
  }

  function remove(i: number) {
    value = value.filter((_, idx) => idx !== i);
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      add();
    }
  }
</script>

<div class="border border-input rounded-md p-2 flex flex-wrap gap-1">
  {#each value as t, i (t)}
    <span
      class="bg-secondary text-secondary-foreground text-xs rounded px-2 py-0.5 inline-flex items-center gap-1"
    >
      {t}
      <button
        type="button"
        class="text-muted-foreground hover:text-foreground"
        onclick={() => remove(i)}>×</button
      >
    </span>
  {/each}
  <input
    type="text"
    class="flex-1 min-w-32 outline-none bg-transparent text-sm"
    bind:value={draft}
    onkeydown={onKey}
    onblur={add}
    {placeholder}
  />
</div>
