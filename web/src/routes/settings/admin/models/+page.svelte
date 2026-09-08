<script lang="ts">
  import * as Card from '$lib/components/ui/card';
  import * as Alert from '$lib/components/ui/alert';
  import { Info, TriangleAlert } from '@lucide/svelte';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { SelectField } from '$lib/components/ui/select-field';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import PageContainer from '$lib/components/PageContainer.svelte';
  import Seo from '$lib/components/Seo.svelte';
  import { toast } from 'svelte-sonner';
  import { untrack } from 'svelte';

  type GatewayModel = {
    id: string;
    name: string;
    inputPerToken: number | null;
    outputPerToken: number | null;
  };
  type FunctionRow = {
    fn: string;
    label: string;
    description: string;
    defaultModelId: string;
    configuredModelId: string | null;
  };
  type PageData = {
    functions: FunctionRow[];
    catalogue: { models: GatewayModel[]; unavailable: string | null };
  };

  let { data }: { data: PageData } = $props();

  // The catalogue is the offer, not the constraint: a deployment with no
  // Gateway key still has to be able to set an id, so the free-text field is
  // always there and the select is an easier way to fill it.
  const options = $derived(
    data.catalogue.models.map((m) => ({
      value: m.id,
      label: m.inputPerToken != null ? `${m.id} (${perMillion(m.inputPerToken)} in)` : m.id,
    })),
  );

  function perMillion(perToken: number): string {
    const usd = perToken * 1_000_000;
    return usd < 1 ? `$${usd.toFixed(2)}/Mtok` : `$${usd.toFixed(0)}/Mtok`;
  }

  // Read once on purpose: this is the form's own editable copy of what the
  // loader returned, not a mirror of it.
  let values = $state<Record<string, string>>(
    Object.fromEntries(
      untrack(() => data.functions).map((f) => [f.fn, f.configuredModelId ?? '']),
    ),
  );
  let saving = $state<string | null>(null);

  async function save(fn: string) {
    saving = fn;
    try {
      const res = await fetch('/api/settings/model-functions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fn, modelId: values[fn] ?? '' }),
      });
      if (!res.ok) throw new Error(await res.text());
      const row = data.functions.find((f) => f.fn === fn);
      toast.success(
        values[fn]?.trim()
          ? `${row?.label ?? fn} now runs on ${values[fn]}`
          : `${row?.label ?? fn} is back on the default, ${row?.defaultModelId}`,
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save the model');
    } finally {
      saving = null;
    }
  }
</script>

<Seo
  title="Settings - Model configuration"
  description="Which model runs which job on this deployment."
/>

<PageContainer size="default">
  <PageHeader
    title="Model configuration"
    description="Which model does which job. A job nobody configured runs on the coded default, so an unset field is a working deployment rather than a broken one."
  />

  {#if data.catalogue.unavailable}
    <Alert.Root class="mb-4">
      <TriangleAlert class="size-4" />
      <Alert.Description>{data.catalogue.unavailable}</Alert.Description>
    </Alert.Root>
  {:else}
    <Alert.Root class="mb-4">
      <Info class="size-4" />
      <Alert.Description>
        {data.catalogue.models.length} models from the AI Gateway. A change applies to the next run,
        with no restart.
      </Alert.Description>
    </Alert.Root>
  {/if}

  <div class="flex flex-col gap-4">
    {#each data.functions as row (row.fn)}
      <Card.Root data-function={row.fn}>
        <Card.Header>
          <Card.Title>{row.label}</Card.Title>
          <Card.Description>{row.description}</Card.Description>
        </Card.Header>
        <Card.Content class="flex flex-col gap-3">
          {#if options.length > 0}
            <SelectField
              value={values[row.fn] ?? ''}
              {options}
              placeholder="Pick a model from the Gateway"
              onValueChange={(v: string) => (values[row.fn] = v)}
            />
          {/if}
          <Input
            bind:value={values[row.fn]}
            placeholder={row.defaultModelId}
            aria-label={`Model id for ${row.label}`}
          />
          <div class="flex items-center justify-between gap-2">
            <span class="text-xs text-muted-foreground">
              {#if values[row.fn]?.trim()}
                Default is {row.defaultModelId}. Clear the field to go back to it.
              {:else}
                Running on the default, {row.defaultModelId}.
              {/if}
            </span>
            <Button size="sm" disabled={saving === row.fn} onclick={() => save(row.fn)}>
              {saving === row.fn ? 'Saving' : 'Save'}
            </Button>
          </div>
        </Card.Content>
      </Card.Root>
    {/each}
  </div>
</PageContainer>
