<script lang="ts">
  import * as Card from '$lib/components/ui/card';
  import { Button } from '$lib/components/ui/button';
  import { Puzzle, RefreshCw, Eye, EyeOff, Copy } from 'lucide-svelte';

  type Props = {
    token: string | null;
    createdAt: string | null;
    backendUrl: string;
  };
  let { token: initialToken, createdAt: initialCreatedAt, backendUrl }: Props = $props();

  // Seed local mutable state from props once; subsequent changes come from the rotate API call.
  // svelte-ignore state_referenced_locally
  let token = $state<string | null>(initialToken);
  // svelte-ignore state_referenced_locally
  let createdAt = $state<string | null>(initialCreatedAt);
  let revealed = $state(false);
  let busy = $state(false);
  let copied = $state(false);

  async function rotate() {
    if (
      !confirm(
        'Rotate the extension token? The extension will stop working until you paste the new one into the popup.',
      )
    )
      return;
    await doRotate();
  }

  async function generate() {
    await doRotate();
  }

  async function doRotate() {
    busy = true;
    try {
      const r = await fetch('/api/extension/token', { method: 'POST' });
      if (!r.ok) throw new Error(`token rotation failed: ${r.status}`);
      const body = (await r.json()) as { token: string; createdAt: string };
      token = body.token;
      createdAt = body.createdAt;
      revealed = true;
    } finally {
      busy = false;
    }
  }

  async function copyToken() {
    if (!token) return;
    await navigator.clipboard.writeText(token);
    copied = true;
    setTimeout(() => (copied = false), 1500);
  }
</script>

<Card.Root size="sm">
  <Card.Header class="flex flex-row flex-nowrap items-center gap-2 space-y-0">
    <Puzzle class="size-4 shrink-0 text-muted-foreground" />
    <Card.Title class="text-base min-w-0 flex-1 truncate">Browser extension</Card.Title>
    {#if token}
      <span
        class="shrink-0 rounded border bg-muted px-1.5 py-[1px] font-mono text-[10px] text-muted-foreground"
      >
        token set
      </span>
    {/if}
  </Card.Header>
  <Card.Content class="flex flex-col gap-3 text-sm">
    <p class="text-xs text-muted-foreground">
      Pairs a Chrome companion extension with this dashboard. After approving a draft and clicking
      <em>Open compose</em>, the extension auto-flips the draft to
      <code class="text-xs">sent</code> when you submit on Reddit.
    </p>

    {#if !token}
      <Button onclick={generate} disabled={busy}>Generate token</Button>
    {:else}
      <div class="flex items-center gap-2">
        <code class="flex-1 truncate rounded border bg-muted px-2 py-1 font-mono text-xs">
          {revealed ? token : '•'.repeat(48)}
        </code>
        <Button
          variant="outline"
          size="icon"
          onclick={() => (revealed = !revealed)}
          title={revealed ? 'Hide' : 'Reveal'}
        >
          {#if revealed}
            <EyeOff class="size-4" />
          {:else}
            <Eye class="size-4" />
          {/if}
        </Button>
        <Button
          variant="outline"
          size="icon"
          onclick={copyToken}
          disabled={!revealed}
          title={copied ? 'Copied!' : 'Copy'}
        >
          <Copy class="size-4" />
        </Button>
        <Button
          variant="outline"
          size="icon"
          onclick={rotate}
          disabled={busy}
          title="Rotate token"
        >
          <RefreshCw class="size-4" />
        </Button>
      </div>
      {#if createdAt}
        <p class="text-xs text-muted-foreground">
          Generated {new Date(createdAt).toLocaleString()}.
        </p>
      {/if}
    {/if}

    <details class="text-xs text-muted-foreground">
      <summary class="cursor-pointer select-none">Install instructions</summary>
      <ol class="mt-2 list-inside list-decimal space-y-1">
        <li>From the repo root: <code>npm run build:extension</code>.</li>
        <li>
          Open <code>chrome://extensions</code>, enable <em>Developer mode</em>.
        </li>
        <li>
          Click <em>Load unpacked</em> and choose <code>extension/dist/</code>.
        </li>
        <li>Click the Pitchbox icon in the toolbar, paste the URL + token below, Connect.</li>
      </ol>
      <div class="mt-2 font-mono">
        <div>Backend URL: <code>{backendUrl}</code></div>
      </div>
    </details>
  </Card.Content>
</Card.Root>
