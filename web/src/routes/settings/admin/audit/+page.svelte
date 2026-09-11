<script lang="ts">
  import * as Card from '$lib/components/ui/card';
  import * as Table from '$lib/components/ui/table';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import PageContainer from '$lib/components/PageContainer.svelte';
  import Seo from '$lib/components/Seo.svelte';
  import { page } from '$app/stores';
  import { t, type Locale } from '$lib/i18n/index.js';

  const locale = $derived($page.data.locale as Locale);

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
  title={t(locale, 'settings.admin.audit.seo-title')}
  description={t(locale, 'settings.admin.audit.seo-description')}
/>

<PageContainer size="wide">
  <PageHeader
    title={t(locale, 'settings.admin.audit.title')}
    description={t(locale, 'settings.admin.audit.description')}
  />

  <Card.Root size="sm" class="mt-4">
    <Card.Content class="py-2">
      <Table.Root>
        <Table.Header>
          <Table.Row>
            <Table.Head class="w-44">{t(locale, 'settings.admin.audit.column-timestamp')}</Table.Head>
            <Table.Head class="w-40">{t(locale, 'settings.admin.audit.column-actor')}</Table.Head>
            <Table.Head class="w-56">{t(locale, 'settings.admin.audit.column-key')}</Table.Head>
            <Table.Head>{t(locale, 'settings.admin.audit.column-before')}</Table.Head>
            <Table.Head>{t(locale, 'settings.admin.audit.column-after')}</Table.Head>
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
                {t(locale, 'settings.admin.audit.empty')}
              </Table.Cell>
            </Table.Row>
          {/if}
        </Table.Body>
      </Table.Root>
    </Card.Content>
  </Card.Root>
</PageContainer>
