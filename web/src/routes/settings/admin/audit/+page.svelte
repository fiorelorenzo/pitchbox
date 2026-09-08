<script lang="ts">
  import * as Card from '$lib/components/ui/card';
  import * as Table from '$lib/components/ui/table';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import PageContainer from '$lib/components/PageContainer.svelte';
  import Seo from '$lib/components/Seo.svelte';

  type AuditRow = {
    id: number;
    key: string;
    actor: string;
    before: unknown;
    after: unknown;
    createdAt: string;
  };

  type PageData = { rows: AuditRow[] };

  let { data }: { data: PageData } = $props();

  function fmt(d: string): string {
    return new Date(d).toLocaleString();
  }

  // A raw `null` reads as an empty field, not the string "null" - most rows
  // only touch one side of a create-vs-clear write (e.g. the default runner
  // going from unset to 'claude-code').
  function fmtValue(v: unknown): string {
    if (v === null || v === undefined) return '-';
    return JSON.stringify(v);
  }
</script>

<Seo
  title="Settings - Instance admin - Audit"
  description="Who changed instance-wide configuration, when, and from what to what."
/>

<PageContainer size="wide">
  <PageHeader
    title="Instance audit log"
    description="Every instance-wide configuration write - not the per-organization audit feed at /audit, which stays scoped to your own organization's drafts and runs."
  />

  <Card.Root size="sm" class="mt-4">
    <Card.Content class="py-2">
      <Table.Root>
        <Table.Header>
          <Table.Row>
            <Table.Head class="w-44">Timestamp</Table.Head>
            <Table.Head class="w-40">Actor</Table.Head>
            <Table.Head class="w-56">Key</Table.Head>
            <Table.Head>Before</Table.Head>
            <Table.Head>After</Table.Head>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {#each data.rows as r (r.id)}
            <Table.Row>
              <Table.Cell class="text-xs font-mono text-muted-foreground">{fmt(r.createdAt)}</Table.Cell>
              <Table.Cell class="text-xs">{r.actor}</Table.Cell>
              <Table.Cell class="font-mono text-xs">{r.key}</Table.Cell>
              <Table.Cell class="max-w-xs truncate font-mono text-xs text-muted-foreground"
                title={fmtValue(r.before)}>{fmtValue(r.before)}</Table.Cell
              >
              <Table.Cell class="max-w-xs truncate font-mono text-xs" title={fmtValue(r.after)}
                >{fmtValue(r.after)}</Table.Cell
              >
            </Table.Row>
          {/each}
          {#if data.rows.length === 0}
            <Table.Row>
              <Table.Cell colspan={5} class="text-center text-sm text-muted-foreground py-8">
                No instance-wide configuration has been changed yet.
              </Table.Cell>
            </Table.Row>
          {/if}
        </Table.Body>
      </Table.Root>
    </Card.Content>
  </Card.Root>
</PageContainer>
