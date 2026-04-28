<script lang="ts">
  type Props = {
    projectId: number;
    configs: { key: string; value: unknown; version: number }[];
  };
  let { projectId, configs }: Props = $props();
</script>
<div class="text-sm text-muted-foreground">
  Configs tab coming up. ({configs.length} config keys for project #{projectId})
</div>
