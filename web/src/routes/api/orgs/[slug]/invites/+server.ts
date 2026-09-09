import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { getDb } from '$lib/server/db.js';
import { createInvite, findOrgBySlug, isOrgAdmin } from '@pitchbox/shared/orgs';
import { createMailTransport } from '@pitchbox/shared/mail/registry';
import { loadMailEnv } from '@pitchbox/shared/mail/env';
import { renderPlainTextMail } from '@pitchbox/shared/mail/template';
import { billingPeriodFor } from '@pitchbox/shared/org-quota';
import { getOrgUsage } from '@pitchbox/shared/usage';
import { checkUsageThresholds } from '@pitchbox/shared/usage-notifications';
import { isOrgReadOnly } from '@pitchbox/shared/plans';

const Body = z.object({
  email: z.email().optional(),
  role: z.enum(['owner', 'admin', 'member']).default('member'),
});

/**
 * Builds the invite email body. The link is built from `origin` - the
 * caller's own `event.url.origin`, which adapter-node resolves from the
 * ORIGIN env var (see `web/src/lib/trusted-origins.js`) rather than a
 * hardcoded host, so a deployment on any domain gets a link that works.
 */
function inviteMail(args: {
  to: string;
  orgName: string;
  role: string;
  origin: string;
  token: string;
  expiresAt: Date;
}) {
  const url = `${args.origin}/invite/${args.token}`;
  const rendered = renderPlainTextMail(
    `You're invited to join ${args.orgName} on Pitchbox`,
    `You've been invited to join ${args.orgName} on Pitchbox as ${args.role}.\n\n` +
      `Accept the invite: ${url}\n\n` +
      `This invite expires on ${args.expiresAt.toDateString()}. If you weren't ` +
      `expecting this, you can ignore this email.`,
  );
  return { to: args.to, subject: rendered.subject, text: rendered.text, html: rendered.html };
}

export async function POST(event: import('@sveltejs/kit').RequestEvent) {
  const user = event.locals.user;
  if (!user) return json({ error: 'unauthenticated' }, { status: 401 });
  const slug = event.params.slug as string;
  const db = getDb();
  const org = await findOrgBySlug(db, slug);
  // 404 if org doesn't exist or the caller isn't an admin of it - avoid
  // leaking existence of orgs the user can't see.
  if (!org) return json({ error: 'not_found' }, { status: 404 });
  if (!(await isOrgAdmin(db, user.id, org.id))) {
    return json({ error: 'not_found' }, { status: 404 });
  }
  const raw = await event.request.json().catch(() => ({}));
  const parsed = Body.safeParse(raw);
  if (!parsed.success) {
    return json({ error: 'invalid_body', issues: parsed.error.issues }, { status: 400 });
  }
  // #548: an invite is a seat the moment it's pending, not only once
  // accepted - otherwise the seat limit is bypassed by inviting ten people
  // at once (shared/src/usage.ts's getOrgUsage already counts it that way).
  const period = await billingPeriodFor(db, org.id);
  const usage = await getOrgUsage(db, org.id, period);
  // #557: a courtesy notification never blocks the invite, admitted or
  // refused by the checks below.
  try {
    await checkUsageThresholds(db, org.id, usage, period);
  } catch (err) {
    console.error('[invites] checkUsageThresholds failed:', err);
  }
  // #554: a failed payment past its grace window refuses before the plan's
  // own seat limit below.
  if (isOrgReadOnly(usage.entitlements)) {
    return json({ error: 'plan_payment_required' }, { status: 402 });
  }
  if (usage.seats.limit != null && usage.seats.used >= usage.seats.limit) {
    return json(
      {
        error: 'plan_limit_reached',
        metric: 'seats',
        limit: usage.seats.limit,
        used: usage.seats.used,
      },
      { status: 402 },
    );
  }
  const invite = await createInvite(db, {
    organizationId: org.id,
    role: parsed.data.role,
    email: parsed.data.email ?? null,
    createdByUserId: user.id,
  });
  const url = `${event.url.origin}/invite/${invite.token}`;
  // The link stays the fallback regardless of a mail attempt (#510): a
  // self-host with nothing configured selects the null transport, which
  // logs and drops rather than delivering anywhere, so `emailSent` tells
  // the UI whether a real transport actually took it.
  let emailSent = false;
  if (parsed.data.email) {
    const transport = createMailTransport(loadMailEnv());
    await transport.send(
      inviteMail({
        to: parsed.data.email,
        orgName: org.name,
        role: parsed.data.role,
        origin: event.url.origin,
        token: invite.token,
        expiresAt: invite.expiresAt,
      }),
    );
    emailSent = transport.name !== 'null';
  }
  return json(
    { token: invite.token, url, expiresAt: invite.expiresAt, emailSent },
    { status: 201 },
  );
}
