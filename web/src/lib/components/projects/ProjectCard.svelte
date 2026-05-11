<script lang="ts">
  type Props = {
    project: {
      id: number;
      slug: string;
      name: string;
      description: string | null;
      campaignCount: number;
      accountCount: number;
    };
  };
  let { project }: Props = $props();

  // Strip enough markdown for a one-paragraph preview: headings, emphasis, code fences,
  // inline code, link markup, list bullets, blockquote arrows, then collapse whitespace.
  function toPreview(md: string): string {
    return md
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/^\s{0,3}#{1,6}\s+/gm, '')
      .replace(/^\s{0,3}>\s?/gm, '')
      .replace(/^\s*[-*+]\s+/gm, '')
      .replace(/^\s*\d+\.\s+/gm, '')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/__([^_]+)__/g, '$1')
      .replace(/\*([^*]+)\*/g, '$1')
      .replace(/_([^_]+)_/g, '$1')
      .replace(/!\[[^\]]*\]\([^)]+\)/g, '')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/\s+/g, ' ')
      .trim();
  }

  const preview = $derived(project.description ? toPreview(project.description) : '');
</script>

<a
  href={`/projects/${project.id}`}
  class="block border border-border rounded-lg p-4 hover:bg-accent/30 transition-colors"
>
  <div class="flex items-baseline justify-between gap-2 mb-1">
    <h3 class="font-medium truncate">{project.name}</h3>
    <code class="text-xs text-muted-foreground">{project.slug}</code>
  </div>
  {#if preview}
    <p class="text-sm text-muted-foreground line-clamp-2 mb-3">{preview}</p>
  {/if}
  <div class="text-xs text-muted-foreground flex gap-3">
    <span>{project.campaignCount} campaigns</span>
    <span>{project.accountCount} accounts</span>
  </div>
</a>
