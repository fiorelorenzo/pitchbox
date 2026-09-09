<!-- The paired backends on home (#400): one row per backend with the actions
     that clear a red state on it (test, disconnect), plus the two ways to add
     one. Was ConnectionCard until #399: the card chrome and its own health
     badge are gone, because home now states the aggregate once above this
     list (D21 in docs/design/DECISIONS.md) and a second badge here would be
     the same answer told twice.

     The permission request stays in this component and stays synchronous
     after the click: chrome.permissions.request only works inside a user
     gesture, so nothing may be awaited between the click and the request. -->
<script lang="ts">
  import { Button } from '$ui/button';
  import { Input } from '$ui/input';
  import * as AlertDialog from '$ui/alert-dialog';
  import { t } from '$ext/i18n';
  import { api, type LinkedInAssistPlanState } from '$ext/api';
  import PlanReadout from './PlanReadout.svelte';
  import {
    patchPairing,
    removePairing,
    upsertPairing,
    pairingHealth,
    type Pairing,
    type PairingHealth,
  } from '$ext/storage';
  import { DEFAULT_BACKEND_URL, normalizeBackendUrl } from '$ext/backend';
  import { originStillNeeded } from '$ext/permissions';
  import { autoPairOutcomeMessageKey, type AutoPairOutcome } from '$ext/auto-pair-outcome';
  // The *built* auto-pair script, as a standalone IIFE, because this path
  // injects it on demand into a tab that has usually run it once already.
  //
  // Two bugs sat here. Injecting the source path `src/content/auto-pair.ts`
  // only ever worked under `vite dev`, where that file is served as written;
  // in a real build it does not exist, executeScript rejected, and pairing
  // reported "No Pitchbox dashboard found in that tab" while looking straight
  // at the dashboard. Pointing at crxjs's `?script` output fixed the
  // rejection and replaced it with a silent no-op: that output is an ESM
  // loader that dynamic-imports the real chunk, and the dashboard's own
  // declared content script has already imported that chunk in this
  // document, so the module is cached and its top-level run never happens a
  // second time. `?iife` is self-contained, so every injection executes.
  import autoPairScriptPath from '../../content/auto-pair.ts?iife';

  // Home owns the pairings and hands them down, rather than this component
  // keeping a second copy. It kept one until #400's own verification caught
  // the consequence on a real panel: home's state line said "Not paired"
  // while this list still rendered the old rows with their Test connection
  // and Disconnect buttons, because the copy here only refreshed on mount.
  // Two readers of the same storage key will always drift; one reader
  // cannot. `onchange` is how a mutation made here gets back up.
  let { pairings, onchange }: { pairings: Pairing[]; onchange: () => Promise<void> | void } =
    $props();

  let busy = $state(false);
  let err = $state<string | null>(null);

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

  // #556: the plan and remaining-suggestion allowance per paired backend,
  // display only - the server refuses regardless of what this says (D28
  // in docs/design/DECISIONS.md). Fetched here rather than through home's
  // own `getSettings()`/`chrome.storage` read: this is live backend state,
  // not a stored pairing field, so it follows `testConnection`'s own
  // per-row network-call posture instead of the storage-ownership rule.
  let plans = $state<Record<string, LinkedInAssistPlanState>>({});

  $effect(() => {
    for (const p of pairings) void loadPlan(p.backendUrl);
  });

  async function loadPlan(backendUrl: string): Promise<void> {
    const res = await api.linkedinAssist(backendUrl);
    if (res.ok) plans = { ...plans, [backendUrl]: res.data.plan };
  }

  // Every mutation below routes through home, which re-reads storage and
  // hands a fresh `pairings` back down.
  async function refresh() {
    await onchange();
  }

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

  // Per-row dot only. The aggregate badge this component used to carry moved
  // to home's state line (D21); what is left here answers "which of these
  // backends is the unhappy one", which the aggregate cannot say.
  //
  // #383: `pending` is a fourth state, not a shade of warn. A pairing made a
  // moment ago has not synced yet, and painting that amber is what made a
  // successful pairing read as a fault.
  function healthDotClass(h: PairingHealth): string {
    if (h === 'error') return 'bg-red-500';
    if (h === 'warn') return 'bg-amber-500';
    if (h === 'pending') return 'bg-muted-foreground/60';
    return 'bg-emerald-500';
  }
  function healthLabel(h: PairingHealth): string {
    if (h === 'error') return $t('dashboard.connection.sync-error');
    if (h === 'warn') return $t('dashboard.connection.degraded');
    if (h === 'pending') return $t('home.state.pending');
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

  // Injects the auto-pair content script into `target.tabId` and waits for
  // it to report an AutoPairOutcome (see lib/auto-pair-outcome.ts and
  // content/auto-pair.ts). Injection itself failing (restricted page, tab
  // closed, ...) and nobody reporting back within the timeout both mean the
  // same thing to the user: we could not reach a dashboard in that tab.
  function runAutoPairInTab(target: { tabId: number; origin: string }): Promise<AutoPairOutcome> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (outcome: AutoPairOutcome) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        chrome.runtime.onMessage.removeListener(listener);
        resolve(outcome);
      };
      const listener = (msg: unknown) => {
        const m = msg as { type?: string; backendUrl?: string; outcome?: AutoPairOutcome };
        if (m?.type === 'pitchbox:auto-pair-outcome' && m.backendUrl === target.origin && m.outcome) {
          finish(m.outcome);
        }
      };
      const timer = setTimeout(() => finish({ kind: 'no-dashboard' }), 4000);
      chrome.runtime.onMessage.addListener(listener);
      chrome.scripting
        .executeScript({ target: { tabId: target.tabId }, files: [autoPairScriptPath] })
        .catch(() => finish({ kind: 'no-dashboard' }));
    });
  }

  // #186: gathering the target tab is synchronous with the "Pair with this
  // tab" click; the actual permission request + injection wait for explicit
  // confirmation in confirmPair() below, so nothing is persisted yet.
  async function pair() {
    err = null;
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !tab.url) {
      err = $t('dashboard.connection.no-active-tab');
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
      let granted: boolean;
      try {
        granted = await chrome.permissions.request({ origins: [target.origin + '/*'] });
      } catch {
        // Distinct from the user explicitly declining below: the request
        // itself failed (e.g. not in a user-gesture context anymore, or the
        // extension context was invalidated mid-click).
        err = $t('dashboard.connection.perm-request-failed', { host: shortHost(target.origin) });
        return;
      }
      if (!granted) {
        err = $t('dashboard.connection.perm-denied', { host: shortHost(target.origin) });
        return;
      }
      const outcome = await runAutoPairInTab(target);
      const messageKey = autoPairOutcomeMessageKey(outcome);
      if (messageKey) {
        err = $t(messageKey);
        return;
      }
      // 'paired' or 'already-paired': the user already confirmed what's
      // shared, so mark whatever pairing exists for this origin as
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
      let granted: boolean;
      try {
        granted = await chrome.permissions.request({ origins: [target.url + '/*'] });
      } catch {
        // Distinct from the user explicitly declining below: the request
        // itself failed (e.g. not in a user-gesture context anymore, or the
        // extension context was invalidated mid-click).
        err = $t('dashboard.connection.perm-request-failed', { host: new URL(target.url).host });
        return;
      }
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

<div class="flex flex-col gap-3">
  {#if pairings.length === 0}
    <!-- No "open your dashboard and pair from that tab" line here: home's
         state line above says exactly that, and printing it twice is what the
         first render of this surface actually did. -->
    <p class="text-xs text-muted-foreground">
      {$t('dashboard.connection.default-hint', { url: shortHost(DEFAULT_BACKEND_URL) })}
    </p>
    <Button disabled={busy} onclick={pair}>
      {busy ? $t('dashboard.connection.pairing') : $t('dashboard.connection.pair')}
    </Button>
  {:else}
    <div class="flex flex-col divide-y divide-border rounded-md border bg-muted/30">
      {#each pairings as p (p.backendUrl)}
        {@const health = pairingHealth(p)}
        {@const testResult = testResults[p.backendUrl]}
        <div class="flex flex-col gap-2 px-3 py-2.5">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <div class="flex min-w-40 flex-1 flex-col gap-0.5">
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
              <div class="truncate pl-4 text-xs text-muted-foreground">
                {$t('dashboard.connection.handshake-ago', { ago: fmtAgo(p.lastHandshakeAt) })}
                ·
                {$t('dashboard.connection.sync-ago', { ago: fmtAgo(p.lastDmSyncAt) })}
              </div>
              {#if plans[p.backendUrl]}
                <PlanReadout plan={plans[p.backendUrl]} />
              {/if}
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
            <div class="ml-auto flex shrink-0 items-center gap-1">
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
      {busy ? $t('dashboard.connection.pairing') : $t('dashboard.connection.pair-another')}
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
</div>
