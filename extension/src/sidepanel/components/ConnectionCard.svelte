<!-- Connection card: shows paired backends and lets the user pair or disconnect. -->
<script lang="ts">
  import { onMount } from 'svelte';
  import { Card, CardContent, CardHeader, CardTitle } from '$ui/card';
  import { Button } from '$ui/button';
  import { Input } from '$ui/input';
  import * as AlertDialog from '$ui/alert-dialog';
  import { t } from '$ext/i18n';
  import { api } from '$ext/api';
  import {
    getSettings as getStorage,
    patchPairing,
    removePairing,
    upsertPairing,
    pairingHealth,
    overallHealth,
    type Pairing,
    type PairingHealth,
  } from '$ext/storage';
  import { DEFAULT_BACKEND_URL, normalizeBackendUrl } from '$ext/backend';
  import { originStillNeeded } from '$ext/permissions';

  let pairings = $state<Pairing[]>([]);
  let busy = $state(false);
  let err = $state<string | null>(null);

  // #178: worst-of health across every pairing, honestly derived from
  // syncStatus (see pairingHealth/overallHealth in storage.ts) - never
  // hardcoded. null means "no pairings", the separate disconnected state.
  let cardHealth: PairingHealth | null = $derived(
    pairings.length > 0 ? overallHealth(pairings) : null,
  );

  // #186: consent for the "Pair with this tab" flow. Gathering the target
  // tab/origin and opening the dialog is synchronous with the click; the
  // actual permission request + injection only run once the user confirms,
  // in confirmPair() below - so nothing is persisted before that.
  let confirmPairOpen = $state(false);
  let pendingPairTarget = $state<{ tabId: number; origin: string } | null>(null);

  // "Add with a pairing code" form: connects to any backend without needing
  // its dashboard open in a tab (the code is the one-time secret).
  let showAdd = $state(false);
  let formUrl = $state(DEFAULT_BACKEND_URL);
  let formCode = $state('');
  let addBusy = $state(false);
  // #186: consent step between filling the form and actually connecting.
  let confirmCodeOpen = $state(false);
  let pendingCode = $state<{ url: string; code: string } | null>(null);

  // #201: transient per-backend "Test connection" outcome, keyed by
  // backendUrl; cleared automatically a few seconds after it lands.
  type ConnectionTestResult = { ok: true; version: string } | { ok: false; error: string };
  let testPending = $state<Record<string, boolean>>({});
  let testResults = $state<Record<string, ConnectionTestResult>>({});

  async function refresh() {
    const s = await getStorage();
    pairings = s.pairings;
  }
  onMount(refresh);

  function shortHost(url: string) {
    try {
      return new URL(url).host;
    } catch {
      return url;
    }
  }
  function fmtAgo(iso: string | undefined) {
    if (!iso) return '-';
    const ms = Date.now() - new Date(iso).getTime();
    if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
    if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
    if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h`;
    return `${Math.floor(ms / 86_400_000)}d`;
  }

  // #178: badge/dot colors driven by the honest worst-of health derived from
  // syncStatus (see pairingHealth/overallHealth in storage.ts), never
  // hardcoded to green.
  function healthBadgeClass(h: PairingHealth): string {
    if (h === 'error') return 'border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400';
    if (h === 'warn')
      return 'border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400';
    return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400';
  }
  function healthDotClass(h: PairingHealth): string {
    if (h === 'error') return 'bg-red-500';
    if (h === 'warn') return 'bg-amber-500';
    return 'bg-emerald-500';
  }
  function healthLabel(h: PairingHealth): string {
    if (h === 'error') return $t('dashboard.connection.sync-error');
    if (h === 'warn') return $t('dashboard.connection.degraded');
    return $t('dashboard.connection.connected');
  }

  // #201: per-backend "Test connection" - hits the handshake endpoint and
  // shows a transient pass/fail plus the server version, then clears itself.
  async function testConnection(p: Pairing) {
    testPending = { ...testPending, [p.backendUrl]: true };
    const res = await api.handshake(p.backendUrl);
    testPending = { ...testPending, [p.backendUrl]: false };
    testResults = {
      ...testResults,
      [p.backendUrl]: res.ok
        ? { ok: true, version: res.data.version }
        : { ok: false, error: res.error || String(res.status) },
    };
    setTimeout(() => {
      const { [p.backendUrl]: _dropped, ...rest } = testResults;
      testResults = rest;
    }, 6000);
  }

  // #186: one-time acknowledgement for a pairing that was persisted without
  // an explicit confirmation step (the passive auto-pair content script, or
  // a pairing that predates this field). Does not touch the pairing's data
  // flow - only clears the review banner.
  async function acknowledgeConsent(backendUrl: string) {
    await patchPairing(backendUrl, { consentAckAt: new Date().toISOString() });
    await refresh();
  }

  // #186: gathering the target tab is synchronous with the "Pair with this
  // tab" click; the actual permission request + injection wait for explicit
  // confirmation in confirmPair() below, so nothing is persisted yet.
  async function pair() {
    err = null;
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !tab.url) {
      err = 'No active tab';
      return;
    }
    pendingPairTarget = { tabId: tab.id, origin: new URL(tab.url).origin };
    confirmPairOpen = true;
  }

  async function confirmPair() {
    confirmPairOpen = false;
    const target = pendingPairTarget;
    pendingPairTarget = null;
    if (!target) return;
    busy = true;
    err = null;
    try {
      // Must run in this click's user-gesture context, so request the host
      // permission before any other await resolves.
      const granted = await chrome.permissions.request({ origins: [target.origin + '/*'] });
      if (!granted) {
        err = 'Permission denied';
        return;
      }
      await chrome.scripting.executeScript({
        target: { tabId: target.tabId },
        files: ['src/content/auto-pair.ts'],
      });
      await new Promise((r) => setTimeout(r, 700));
      // The user already confirmed what's shared, so mark whatever pairing
      // the injected content script just created for this origin as
      // acknowledged - it should not also show the post-hoc review banner.
      await patchPairing(target.origin, { consentAckAt: new Date().toISOString() });
      await refresh();
    } finally {
      busy = false;
    }
  }

  async function disconnect(url: string) {
    const remaining = await removePairing(url);
    // Best-effort: also drop the standing host permission granted when this
    // backend was paired (see pair()/connectWithCode()), but only if no other
    // remaining pairing still targets the same origin. Revoking an origin
    // that overlaps a required host permission (reddit.com, pitchbox.app,
    // localhost) is a documented no-op, not an error, but guard anyway since
    // this must never block disconnecting.
    try {
      const origin = new URL(url).origin;
      if (!originStillNeeded(remaining, origin)) {
        await chrome.permissions.remove({ origins: [origin + '/*'] });
      }
    } catch {
      // Ignore: worst case the extension keeps an unused host permission.
    }
    await refresh();
  }

  // #186: validate the form and open the consent dialog; the actual
  // permission request + pairing only happen once the user confirms, in
  // confirmConnectWithCode() below.
  function reviewConnect() {
    err = null;
    const url = normalizeBackendUrl(formUrl);
    if (!url) {
      err = $t('dashboard.connection.bad-url');
      return;
    }
    const code = formCode.trim();
    if (!code) {
      err = $t('dashboard.connection.code-required');
      return;
    }
    pendingCode = { url, code };
    confirmCodeOpen = true;
  }

  async function confirmConnectWithCode() {
    confirmCodeOpen = false;
    const target = pendingCode;
    pendingCode = null;
    if (!target) return;
    addBusy = true;
    err = null;
    try {
      // Must run in this click's user-gesture context, so request the host
      // permission before any other await resolves.
      const granted = await chrome.permissions.request({ origins: [target.url + '/*'] });
      if (!granted) {
        err = $t('dashboard.connection.perm-denied', { host: new URL(target.url).host });
        return;
      }
      const res = await api.pairWithCode(target.url, target.code);
      if (!res.ok) {
        err = $t('dashboard.connection.pair-failed', { reason: res.error || String(res.status) });
        return;
      }
      await upsertPairing({
        backendUrl: target.url,
        token: res.data.token,
        orgName: res.data.orgName ?? undefined,
        deviceLabel: res.data.deviceLabel,
        lastHandshakeAt: new Date().toISOString(),
        // The user just confirmed what's shared, so this pairing needs no
        // post-hoc review banner.
        consentAckAt: new Date().toISOString(),
      });
      formCode = '';
      showAdd = false;
      await refresh();
    } finally {
      addBusy = false;
    }
  }
</script>

<Card>
  <CardHeader class="flex flex-row items-center justify-between gap-2 space-y-0">
    <CardTitle>{$t('dashboard.connection.title')}</CardTitle>
    <span
      class="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium {cardHealth
        ? healthBadgeClass(cardHealth)
        : 'border-muted-foreground/30 bg-muted text-muted-foreground'}"
    >
      <span
        class="size-1.5 rounded-full {cardHealth
          ? healthDotClass(cardHealth)
          : 'bg-muted-foreground/60'}"
      ></span>
      {cardHealth ? healthLabel(cardHealth) : $t('dashboard.connection.disconnected')}
    </span>
  </CardHeader>
  <CardContent class="flex flex-col gap-3">
    {#if pairings.length === 0}
      <p class="text-sm text-muted-foreground">{$t('dashboard.connection.empty')}</p>
      <p class="text-xs text-muted-foreground">
        {$t('dashboard.connection.default-hint', { url: shortHost(DEFAULT_BACKEND_URL) })}
      </p>
      <Button disabled={busy} onclick={pair}>
        {$t('dashboard.connection.pair')}
      </Button>
    {:else}
      <div class="flex flex-col divide-y divide-border rounded-md border bg-muted/30">
        {#each pairings as p (p.backendUrl)}
          {@const health = pairingHealth(p)}
          {@const testResult = testResults[p.backendUrl]}
          <div class="flex flex-col gap-2 px-3 py-2.5">
            <div class="flex items-center justify-between gap-2">
              <div class="flex min-w-0 flex-1 flex-col gap-0.5">
                <div class="flex items-center gap-2">
                  <span
                    class="size-2 shrink-0 rounded-full {healthDotClass(health)}"
                    title={healthLabel(health)}
                    aria-hidden="true"
                  ></span>
                  <span class="truncate text-sm font-medium" title={p.backendUrl}>
                    {shortHost(p.backendUrl)}
                  </span>
                </div>
                {#if p.orgName || p.deviceLabel}
                  <div class="truncate pl-4 text-xs text-muted-foreground">
                    {[p.orgName, p.deviceLabel].filter(Boolean).join(' · ')}
                  </div>
                {/if}
                <div class="pl-4 text-xs text-muted-foreground">
                  {$t('dashboard.connection.handshake-ago', { ago: fmtAgo(p.lastHandshakeAt) })}
                  ·
                  {$t('dashboard.connection.sync-ago', { ago: fmtAgo(p.lastDmSyncAt) })}
                </div>
                {#if testResult}
                  <div
                    class="pl-4 text-xs {testResult.ok
                      ? 'text-emerald-600 dark:text-emerald-400'
                      : 'text-destructive'}"
                  >
                    {testResult.ok
                      ? $t('dashboard.connection.test-ok', { version: testResult.version })
                      : $t('dashboard.connection.test-fail', { reason: testResult.error })}
                  </div>
                {/if}
              </div>
              <div class="flex shrink-0 items-center gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={testPending[p.backendUrl]}
                  onclick={() => testConnection(p)}
                >
                  {testPending[p.backendUrl]
                    ? $t('dashboard.connection.testing')
                    : $t('dashboard.connection.test')}
                </Button>
                <Button variant="ghost" size="sm" onclick={() => disconnect(p.backendUrl)}>
                  {$t('dashboard.connection.disconnect')}
                </Button>
              </div>
            </div>
            {#if !p.consentAckAt}
              <div
                class="rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-2 text-xs text-amber-700 dark:text-amber-400"
              >
                <p class="font-medium">
                  {$t('dashboard.connection.consent-review-title', {
                    host: shortHost(p.backendUrl),
                  })}
                </p>
                <p class="mt-0.5 text-muted-foreground">
                  {$t('dashboard.connection.consent-body')}
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  class="mt-1.5"
                  onclick={() => acknowledgeConsent(p.backendUrl)}
                >
                  {$t('dashboard.connection.consent-ack')}
                </Button>
              </div>
            {/if}
          </div>
        {/each}
      </div>
      <Button variant="outline" disabled={busy} onclick={pair}>
        {$t('dashboard.connection.pair-another')}
      </Button>
    {/if}
    <div class="flex flex-col gap-2 border-t pt-3">
      {#if !showAdd}
        <Button variant="ghost" size="sm" class="self-start" onclick={() => (showAdd = true)}>
          {$t('dashboard.connection.add-toggle')}
        </Button>
      {:else}
        <p class="text-xs text-muted-foreground">{$t('dashboard.connection.add-hint')}</p>
        <Input bind:value={formUrl} placeholder={$t('dashboard.connection.backend-placeholder')} />
        <Input bind:value={formCode} placeholder={$t('dashboard.connection.code-placeholder')} />
        <div class="flex gap-2">
          <Button disabled={addBusy} onclick={reviewConnect}>
            {addBusy ? $t('dashboard.connection.connecting') : $t('dashboard.connection.connect')}
          </Button>
          <Button variant="ghost" disabled={addBusy} onclick={() => (showAdd = false)}>
            {$t('dashboard.connection.cancel')}
          </Button>
        </div>
      {/if}
    </div>
    {#if err}
      <p class="text-xs text-destructive">{err}</p>
    {/if}

    <AlertDialog.Root bind:open={confirmPairOpen}>
      <AlertDialog.Content>
        <AlertDialog.Header>
          <AlertDialog.Title>
            {$t('dashboard.connection.consent-title', {
              host: pendingPairTarget ? shortHost(pendingPairTarget.origin) : '',
            })}
          </AlertDialog.Title>
          <AlertDialog.Description>
            {$t('dashboard.connection.consent-body')}
          </AlertDialog.Description>
        </AlertDialog.Header>
        <AlertDialog.Footer>
          <AlertDialog.Cancel
            onclick={() => {
              confirmPairOpen = false;
              pendingPairTarget = null;
            }}
          >
            {$t('dashboard.connection.cancel')}
          </AlertDialog.Cancel>
          <AlertDialog.Action variant="default" onclick={confirmPair}>
            {$t('dashboard.connection.consent-confirm')}
          </AlertDialog.Action>
        </AlertDialog.Footer>
      </AlertDialog.Content>
    </AlertDialog.Root>

    <AlertDialog.Root bind:open={confirmCodeOpen}>
      <AlertDialog.Content>
        <AlertDialog.Header>
          <AlertDialog.Title>
            {$t('dashboard.connection.consent-title', {
              host: pendingCode ? new URL(pendingCode.url).host : '',
            })}
          </AlertDialog.Title>
          <AlertDialog.Description>
            {$t('dashboard.connection.consent-body')}
          </AlertDialog.Description>
        </AlertDialog.Header>
        <AlertDialog.Footer>
          <AlertDialog.Cancel
            onclick={() => {
              confirmCodeOpen = false;
              pendingCode = null;
            }}
          >
            {$t('dashboard.connection.cancel')}
          </AlertDialog.Cancel>
          <AlertDialog.Action variant="default" onclick={confirmConnectWithCode}>
            {$t('dashboard.connection.consent-confirm')}
          </AlertDialog.Action>
        </AlertDialog.Footer>
      </AlertDialog.Content>
    </AlertDialog.Root>
  </CardContent>
</Card>
