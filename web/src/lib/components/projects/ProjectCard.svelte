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
</script>

<a
  href={`/projects/${project.id}`}
  class="block border border-border rounded-lg p-4 hover:bg-accent/30 transition-colors"
>
  <div class="flex items-baseline justify-between gap-2 mb-1">
    <h3 class="font-medium truncate">{project.name}</h3>
    <code class="text-xs text-muted-foreground">{project.slug}</code>
  </div>
  {#if project.description}
    <p class="text-sm text-muted-foreground line-clamp-2 mb-3">{project.description}</p>
  {/if}
  <div class="text-xs text-muted-foreground flex gap-3">
    <span>{project.campaignCount} campaigns</span>
    <span>{project.accountCount} accounts</span>
  </div>
</a>
