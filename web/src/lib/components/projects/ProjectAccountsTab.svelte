<script lang="ts">
  type Props = {
    projectId: number;
    accounts: { id: number; handle: string; role: string }[];
    platforms: { slug: string }[];
  };
  let { projectId, accounts, platforms }: Props = $props();
</script>
<div class="text-sm text-muted-foreground">
  Accounts tab coming up. ({accounts.length} accounts; {platforms.length} platforms available)
</div>
