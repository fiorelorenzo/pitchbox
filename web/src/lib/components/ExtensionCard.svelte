<script lang="ts">
  import * as Card from '$lib/components/ui/card';
  import { Puzzle } from 'lucide-svelte';

  type Props = {
    backendUrl: string;
  };
  let { backendUrl }: Props = $props();
</script>

<Card.Root size="sm">
  <Card.Header class="flex flex-row flex-nowrap items-center gap-2 space-y-0">
    <Puzzle class="size-4 shrink-0 text-muted-foreground" />
    <Card.Title class="text-base min-w-0 flex-1 truncate">Browser extension</Card.Title>
  </Card.Header>
  <Card.Content class="flex flex-col gap-3 text-sm">
    <p class="text-xs text-muted-foreground">
      Pairs the Pitchbox Chrome extension with this dashboard. The extension lives in a persistent
      side panel: it auto-flips drafts to <code class="text-xs">sent</code> when you submit on
      Reddit, polls Reddit inbox + Chat for replies, and surfaces every operation in a real-time
      activity log.
    </p>

    <div class="rounded-md border border-border/60 px-3 py-2 text-xs">
      <p class="font-medium">Pair this dashboard</p>
      <ol class="mt-1.5 list-inside list-decimal space-y-1 text-muted-foreground">
        <li>Click the Pitchbox icon in the Chrome toolbar to open the side panel.</li>
        <li>
          Open the <strong>Dashboard</strong> tab, then click <em>Pair with this tab</em>.
        </li>
        <li>Approve the one-time host permission prompt for this origin.</li>
      </ol>
      <p class="mt-2 text-muted-foreground">
        The extension reads your session cookie to mint a per-device token automatically. Manage
        and revoke devices below.
      </p>
    </div>

    <details class="text-xs text-muted-foreground">
      <summary class="cursor-pointer select-none">Install the extension</summary>
      <ol class="mt-2 list-inside list-decimal space-y-1">
        <li>From the repo root: <code>pnpm run build:extension</code>.</li>
        <li>
          Open <code>chrome://extensions</code>, enable <em>Developer mode</em>.
        </li>
        <li>
          Click <em>Load unpacked</em> and choose <code>extension/dist/</code>.
        </li>
        <li>Click the Pitchbox icon to open the side panel, then pair as above.</li>
      </ol>
      <div class="mt-2 font-mono">
        <div>Backend URL: <code>{backendUrl}</code></div>
      </div>
    </details>
  </Card.Content>
</Card.Root>
