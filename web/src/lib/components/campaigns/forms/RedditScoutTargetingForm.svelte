<script lang="ts">
  import { Input } from '$lib/components/ui/input';
  import TagListInput from '$lib/components/projects/TagListInput.svelte';

  type V = {
    targetSubreddits: string[];
    topicKeywords: string[];
    avoidKeywords: string[];
    fitScoreThreshold: number;
  };
  type Props = { value: V; onChange: (v: V) => void; disabled?: boolean };
  let { value, onChange, disabled = false }: Props = $props();

  function patch(p: Partial<V>) {
    onChange({ ...value, ...p });
  }
</script>

<div class="space-y-3">
  <h3 class="text-sm font-medium">Targeting</h3>
  <label class="flex flex-col gap-1 text-xs">
    Target subreddits
    <TagListInput
      value={value.targetSubreddits}
      onChange={(v) => patch({ targetSubreddits: v })}
      {disabled}
      placeholder="rpg"
    />
  </label>
  <label class="flex flex-col gap-1 text-xs">
    Topic keywords
    <TagListInput
      value={value.topicKeywords}
      onChange={(v) => patch({ topicKeywords: v })}
      {disabled}
      placeholder="ai dm"
    />
  </label>
  <label class="flex flex-col gap-1 text-xs">
    Avoid keywords
    <TagListInput
      value={value.avoidKeywords}
      onChange={(v) => patch({ avoidKeywords: v })}
      {disabled}
      placeholder="spam"
    />
  </label>
  <label class="flex flex-col gap-1 text-xs">
    Fit score threshold (1–5)
    <Input
      type="number"
      min={1}
      max={5}
      value={value.fitScoreThreshold}
      {disabled}
      oninput={(e) =>
        patch({ fitScoreThreshold: Number((e.currentTarget as HTMLInputElement).value) })}
    />
  </label>
</div>
