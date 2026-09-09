<!-- The plan and remaining-suggestion allowance for one paired backend (#556),
     shown next to that pairing's own connection state. Display only: the
     server refuses a suggestion regardless of what this says
     (docs/design/DECISIONS.md D28), so a stale fetch here can only ever
     under- or over-state the allowance, never let one through.

     Its own component, not inline in PairingList.svelte's row markup: that
     component already carries the pairing/permission/dialog machinery, and
     keeping this presentational sliver separate is what lets it be mounted
     and tested on its own. `PairingList` owns the fetch (one owner reads
     the network, matching how it already owns `chrome.storage`); this only
     renders what it is handed. -->
<script lang="ts">
  import { t } from '$ext/i18n';
  import type { LinkedInAssistPlanState } from '$ext/api';

  let { plan }: { plan: LinkedInAssistPlanState } = $props();

  // Reuses #557's own 80%-used notification threshold, so this readout's
  // warning and the org's own email/webhook notice agree on what "near"
  // means rather than inventing a second number.
  const WARNING_USED_RATIO = 0.8;

  function line(p: LinkedInAssistPlanState): { key: string; tone: string } {
    if (p.readOnly) {
      return { key: 'dashboard.connection.plan-read-only', tone: 'text-destructive' };
    }
    if (p.suggestionsLimit == null || p.suggestionsRemaining == null) {
      return { key: 'dashboard.connection.plan-unlimited', tone: 'text-muted-foreground' };
    }
    const usedRatio = p.suggestionsLimit > 0 ? 1 - p.suggestionsRemaining / p.suggestionsLimit : 1;
    if (usedRatio >= WARNING_USED_RATIO) {
      return {
        key: 'dashboard.connection.plan-remaining-low',
        tone: 'text-amber-600 dark:text-amber-400',
      };
    }
    return { key: 'dashboard.connection.plan-remaining', tone: 'text-muted-foreground' };
  }
</script>

<div class="truncate pl-4 text-xs {line(plan).tone}">
  {$t(line(plan).key, {
    plan: plan.name,
    remaining: plan.suggestionsRemaining ?? 0,
    limit: plan.suggestionsLimit ?? 0,
  })}
</div>
