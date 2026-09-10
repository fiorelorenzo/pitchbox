import {
  Bot,
  Gauge,
  Archive,
  Webhook,
  ScrollText,
  CircleDollarSign,
  Cpu,
  CreditCard,
} from '@lucide/svelte';

export type AdminLink = {
  href: string;
  icon: typeof Bot;
  label: string;
  description: string;
};

/**
 * The `settings/admin` landing page's link grid - pulled out of the
 * `+page.svelte` into its own module so it is importable by a test
 * (`web/tests/settings-admin-page-links.test.ts`) without rendering the
 * component, the same reason `shared/src/ai/model-functions.ts`'s
 * `MODEL_FUNCTION_META` lives outside its own page.
 *
 * #185: nothing linked to `settings/admin/models` even though it was a real,
 * gated page - the admin index's first entry, "Agent runners", pointed at
 * the tenant page `settings/runners` instead, which reads as "the place
 * models are set" until you open it and find one runner and no per-function
 * config. That entry's copy is reworded below so it no longer reads that
 * way, and `models` gets its own entry. #187 adds `plan-grants` the same
 * way `spend-ceiling` was added alongside `models`.
 */
export const ADMIN_LINKS: AdminLink[] = [
  {
    href: '/settings/runners',
    icon: Bot,
    label: 'Agent runners',
    description:
      'Default runner and per-runner config for every organization - not where a function\u2019s model is set (see Model configuration).',
  },
  {
    href: '/settings/admin/models',
    icon: Cpu,
    label: 'Model configuration',
    description:
      'Which Gateway model runs each of the five AI functions - drafting, the in-page assist, project extraction and insights, and campaign-profile generation.',
  },
  {
    href: '/settings/quota',
    icon: Gauge,
    label: 'Quota',
    description: 'Per-platform posting quota defaults shared by every organization.',
  },
  {
    href: '/settings/admin/spend-ceiling',
    icon: CircleDollarSign,
    label: 'Spend ceiling',
    description:
      'Instance-wide Gateway ceiling and the caps a self-registered organization starts with.',
  },
  {
    href: '/settings/admin/plan-grants',
    icon: CreditCard,
    label: 'Plan grants',
    description:
      'Set or revoke a plan on any organization directly, bypassing Stripe - the self-host fallback and any hand-granted org.',
  },
  {
    href: '/settings/retention',
    icon: Archive,
    label: 'Retention',
    description: 'How long drafts, run events and webhook deliveries are kept.',
  },
  {
    href: '/notifications',
    icon: Webhook,
    label: 'Outgoing webhook',
    description: 'The dashboard-wide notification webhook URL and its delivery log.',
  },
  {
    href: '/settings/admin/audit',
    icon: ScrollText,
    label: 'Audit log',
    description: 'Who changed instance-wide configuration, when, and from what to what.',
  },
];
