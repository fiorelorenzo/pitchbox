<script lang="ts" module>
  export type Recommendation = {
    id: number;
    scenarioSlug: string;
    name: string;
    objective: string;
  };
</script>

<script lang="ts">
  import { Button } from '$lib/components/ui/button';
  import { Badge } from '$lib/components/ui/badge';
  import * as Card from '$lib/components/ui/card';

  type Props = {
    recommendations: Recommendation[];
    onUse: (rec: Recommendation) => void;
  };
  let { recommendations, onUse }: Props = $props();
</script>

{#if recommendations.length > 0}
  <div class="grid gap-3 md:grid-cols-2">
    {#each recommendations as rec (rec.id)}
      <Card.Root size="sm">
        <Card.Header>
          <div class="flex items-center gap-2">
            <Badge variant="outline" class="font-mono text-[11px]">{rec.scenarioSlug}</Badge>
            <Card.Title class="text-sm leading-tight">{rec.name}</Card.Title>
          </div>
        </Card.Header>
        <Card.Content>
          <p class="text-xs text-muted-foreground line-clamp-3">{rec.objective}</p>
        </Card.Content>
        <Card.Footer class="justify-end">
          <Button size="sm" variant="outline" onclick={() => onUse(rec)}>Use this →</Button>
        </Card.Footer>
      </Card.Root>
    {/each}
  </div>
{/if}
