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
import { t, type Locale } from '$lib/i18n/index.js';

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
 *
 * LOR-263: labels and descriptions now resolve from the catalogue, so the
 * grid is a function of locale rather than a static array.
 */
export function adminLinks(locale: Locale | null | undefined): AdminLink[] {
  return [
    {
      href: '/settings/runners',
      icon: Bot,
      label: t(locale, 'settings.admin.links.runners-label'),
      description: t(locale, 'settings.admin.links.runners-description'),
    },
    {
      href: '/settings/admin/models',
      icon: Cpu,
      label: t(locale, 'settings.admin.links.models-label'),
      description: t(locale, 'settings.admin.links.models-description'),
    },
    {
      href: '/settings/quota',
      icon: Gauge,
      label: t(locale, 'settings.admin.links.quota-label'),
      description: t(locale, 'settings.admin.links.quota-description'),
    },
    {
      href: '/settings/admin/spend-ceiling',
      icon: CircleDollarSign,
      label: t(locale, 'settings.admin.links.spend-ceiling-label'),
      description: t(locale, 'settings.admin.links.spend-ceiling-description'),
    },
    {
      href: '/settings/admin/plan-grants',
      icon: CreditCard,
      label: t(locale, 'settings.admin.links.plan-grants-label'),
      description: t(locale, 'settings.admin.links.plan-grants-description'),
    },
    {
      href: '/settings/retention',
      icon: Archive,
      label: t(locale, 'settings.admin.links.retention-label'),
      description: t(locale, 'settings.admin.links.retention-description'),
    },
    {
      href: '/notifications',
      icon: Webhook,
      label: t(locale, 'settings.admin.links.webhook-label'),
      description: t(locale, 'settings.admin.links.webhook-description'),
    },
    {
      href: '/settings/admin/audit',
      icon: ScrollText,
      label: t(locale, 'settings.admin.links.audit-label'),
      description: t(locale, 'settings.admin.links.audit-description'),
    },
  ];
}
