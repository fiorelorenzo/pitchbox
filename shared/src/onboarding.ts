import { and, eq, isNull } from 'drizzle-orm';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import {
  accounts,
  drafts,
  extensionDevices,
  onboardingState,
  organizations,
  projects,
  projectSources,
  users,
} from './db/schema.js';
import { isEmailVerified } from './auth.js';
import { defaultOrgName, getMemberRole } from './orgs.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = PgDatabase<any, any, any>;

/**
 * The onboarding sequence version. Bump this when the step list changes;
 * `onboarding_state.version` records which version a row was started or
 * restarted under, so a future change can decide deliberately whether a
 * `completed`/`skipped` row written under an older version should be
 * re-offered - nothing here does that automatically (see #516's own
 * comment: "changing the steps later is a decision... instead of an
 * accident").
 */
export const ONBOARDING_VERSION = 1;

export type OnboardingStepId =
  'organization' | 'verify_email' | 'project' | 'account' | 'extension' | 'first_draft';

/** Order matters: this is the sequence the wizard walks and the order `currentStep` is picked in. */
export const ONBOARDING_STEPS: readonly OnboardingStepId[] = [
  'organization',
  'verify_email',
  'project',
  'account',
  'extension',
  'first_draft',
];

export type OnboardingStatus = 'not_started' | 'in_progress' | 'skipped' | 'completed';

export type OnboardingStepState = {
  id: OnboardingStepId;
  /** Whether this step means anything for this identity (e.g. `organization` and
   * `verify_email` are not applicable with auth off, or to a non-owner member). */
  applicable: boolean;
  /** Read live from the real thing the step is about - never a stored flag. */
  complete: boolean;
};

export type OnboardingSnapshot = {
  status: OnboardingStatus;
  version: number;
  steps: OnboardingStepState[];
  /** The single next applicable+incomplete step, or null when there is nothing left. */
  currentStep: OnboardingStepId | null;
  startedAt: Date | null;
  completedAt: Date | null;
  skippedAt: Date | null;
};

export type OnboardingIdentity = {
  organizationId: number;
  /** Null only for self-host with auth off, where there is no `users` row to key on. */
  userId: number | null;
};

export type OnboardingContext = {
  authOn: boolean;
  /** The signed-in caller's username, needed only to evaluate the `organization` step. */
  username?: string | null;
};

async function findRow(db: Db, identity: OnboardingIdentity) {
  const { organizationId, userId } = identity;
  const condition =
    userId == null
      ? and(eq(onboardingState.organizationId, organizationId), isNull(onboardingState.userId))
      : and(eq(onboardingState.organizationId, organizationId), eq(onboardingState.userId, userId));
  const [row] = await db.select().from(onboardingState).where(condition).limit(1);
  return row ?? null;
}

/**
 * Live per-step completion, read from the real state of the things each
 * step walks the operator through - a project with a source, a connected
 * account, a paired extension device, a first draft - rather than from a
 * copy this table keeps of its own. This is the one place that "is this
 * step actually done" gets decided, and it is safe to call on every page
 * load: five to six cheap indexed lookups, no writes.
 */
export async function computeOnboardingSteps(
  db: Db,
  identity: OnboardingIdentity,
  ctx: OnboardingContext,
): Promise<OnboardingStepState[]> {
  const { organizationId, userId } = identity;
  const { authOn, username } = ctx;

  // organization: applicable only to the owner of an authenticated org (the
  // one #513 derived a name for without asking) - a member has nothing to
  // rename and self-host has no owner concept. Complete once the name on
  // file differs from the pure-function default `defaultOrgName` would
  // still produce for this account - a real column comparison, not a click
  // flag.
  let orgApplicable = false;
  let orgComplete = true;
  if (authOn && userId != null) {
    const role = await getMemberRole(db, organizationId, userId);
    orgApplicable = role === 'owner';
    if (orgApplicable) {
      const [org] = await db
        .select({ name: organizations.name })
        .from(organizations)
        .where(eq(organizations.id, organizationId))
        .limit(1);
      const derivedDefault = username ? defaultOrgName(username) : null;
      orgComplete = !org || derivedDefault == null || org.name !== derivedDefault;
    }
  }

  // verify_email: applicable only when signed in with an address on file -
  // self-host and a pre-#507 account with no email have nothing to prove.
  let verifyApplicable = false;
  let verifyComplete = true;
  if (authOn && userId != null) {
    const [u] = await db
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    verifyApplicable = !!u?.email;
    if (verifyApplicable) verifyComplete = await isEmailVerified(db, userId);
  }

  // project: at least one source, not just an empty project shell - "give
  // the agent something to write about" is the actual bar #516 sets.
  const [projectRow] = await db
    .select({ id: projects.id })
    .from(projects)
    .innerJoin(projectSources, eq(projectSources.projectId, projects.id))
    .where(and(eq(projects.organizationId, organizationId), eq(projectSources.active, true)))
    .limit(1);

  // account: any active platform account on any project in the org.
  const [accountRow] = await db
    .select({ id: accounts.id })
    .from(accounts)
    .innerJoin(projects, eq(projects.id, accounts.projectId))
    .where(and(eq(projects.organizationId, organizationId), eq(accounts.active, true)))
    .limit(1);

  // extension: a non-revoked device paired to this org. Self-host with auth
  // off still resolves a real org id (the seeded `default` org - see
  // resolveOrgId/defaultOrgId in web/src/lib/server), and every pairing
  // path (auto-pair, pairing-code redemption) writes that same real id, so
  // this is a plain equality check with no null-org branch to carry.
  const [deviceRow] = await db
    .select({ id: extensionDevices.id })
    .from(extensionDevices)
    .where(
      and(eq(extensionDevices.organizationId, organizationId), isNull(extensionDevices.revokedAt)),
    )
    .limit(1);

  // first_draft: reaching a draft is the destination this step names - not
  // "sent", which is a further, separate human decision.
  const [draftRow] = await db
    .select({ id: drafts.id })
    .from(drafts)
    .innerJoin(projects, eq(projects.id, drafts.projectId))
    .where(eq(projects.organizationId, organizationId))
    .limit(1);

  return [
    { id: 'organization', applicable: orgApplicable, complete: orgComplete },
    { id: 'verify_email', applicable: verifyApplicable, complete: verifyComplete },
    { id: 'project', applicable: true, complete: !!projectRow },
    { id: 'account', applicable: true, complete: !!accountRow },
    { id: 'extension', applicable: true, complete: !!deviceRow },
    { id: 'first_draft', applicable: true, complete: !!draftRow },
  ];
}

function firstIncomplete(steps: OnboardingStepState[]): OnboardingStepId | null {
  return steps.find((s) => s.applicable && !s.complete)?.id ?? null;
}

function toSnapshot(
  row: {
    status: string;
    version: number;
    startedAt: Date | null;
    completedAt: Date | null;
    skippedAt: Date | null;
  } | null,
  steps: OnboardingStepState[],
): OnboardingSnapshot {
  return {
    status: (row?.status as OnboardingStatus) ?? 'not_started',
    version: row?.version ?? ONBOARDING_VERSION,
    steps,
    currentStep: firstIncomplete(steps),
    startedAt: row?.startedAt ?? null,
    completedAt: row?.completedAt ?? null,
    skippedAt: row?.skippedAt ?? null,
  };
}

/**
 * Reads the current onboarding snapshot with no side effects beyond the one
 * honest reconciliation every caller needs: an `in_progress` row whose live
 * steps are now all satisfied gets marked `completed` right here, because
 * that is a fact about reality becoming true, not a click being tracked. A
 * missing row reads as `not_started` without ever being written - visiting
 * a page must never silently create a row.
 */
export async function getOnboardingSnapshot(
  db: Db,
  identity: OnboardingIdentity,
  ctx: OnboardingContext,
): Promise<OnboardingSnapshot> {
  const row = await findRow(db, identity);
  const steps = await computeOnboardingSteps(db, identity, ctx);
  if (row && row.status === 'in_progress' && firstIncomplete(steps) == null) {
    const [updated] = await db
      .update(onboardingState)
      .set({ status: 'completed', completedAt: new Date(), updatedAt: new Date() })
      .where(eq(onboardingState.id, row.id))
      .returning();
    return toSnapshot(updated, steps);
  }
  return toSnapshot(row, steps);
}

async function upsert(
  db: Db,
  identity: OnboardingIdentity,
  values: Partial<typeof onboardingState.$inferInsert>,
) {
  const row = await findRow(db, identity);
  if (row) {
    await db
      .update(onboardingState)
      .set({ ...values, updatedAt: new Date() })
      .where(eq(onboardingState.id, row.id));
    return;
  }
  try {
    await db.insert(onboardingState).values({
      organizationId: identity.organizationId,
      userId: identity.userId,
      ...values,
    });
  } catch (e) {
    // A concurrent first-visit raced us to the same (user, org) row - the
    // partial unique indexes on onboarding_state caught it. Whoever lost
    // the insert just applies the same update to the row the winner made.
    if (e instanceof Error && /unique|duplicate key/i.test(e.message)) {
      const winner = await findRow(db, identity);
      if (winner) {
        await db
          .update(onboardingState)
          .set({ ...values, updatedAt: new Date() })
          .where(eq(onboardingState.id, winner.id));
        return;
      }
    }
    throw e;
  }
}

/**
 * First sign-in entry point: `not_started` (or no row at all) becomes
 * `in_progress`. A row already in any other status is left untouched - this
 * is not a resume primitive, it is "begin, once". Called from `/onboarding`'s
 * own loader, so visiting the page for the first time is what starts it;
 * nothing elsewhere needs to reach into this table.
 */
export async function startOnboarding(
  db: Db,
  identity: OnboardingIdentity,
  ctx: OnboardingContext,
): Promise<OnboardingSnapshot> {
  const existing = await findRow(db, identity);
  if (!existing || existing.status === 'not_started') {
    await upsert(db, identity, {
      status: 'in_progress',
      startedAt: new Date(),
      version: ONBOARDING_VERSION,
    });
  }
  // getOnboardingSnapshot's own reconciliation immediately promotes this to
  // `completed` when every applicable step already reads true - a
  // pre-populated org (an existing self-host install, an org someone joined
  // after everything was already set up) never sees an empty wizard with
  // nothing left to do.
  return getOnboardingSnapshot(db, identity, ctx);
}

/**
 * The dashboard's dismiss action and the wizard's own "Skip for now": a
 * recorded decision, not a lack of one. No-op when already `skipped` or
 * `completed` (skip only means something on the way there).
 */
export async function skipOnboarding(
  db: Db,
  identity: OnboardingIdentity,
  ctx: OnboardingContext,
): Promise<OnboardingSnapshot> {
  const existing = await findRow(db, identity);
  if (!existing || existing.status === 'not_started' || existing.status === 'in_progress') {
    await upsert(db, identity, { status: 'skipped', skippedAt: new Date() });
  }
  return getOnboardingSnapshot(db, identity, ctx);
}

/**
 * The Settings "Start again" action: valid from every status, including the
 * two terminal ones (#516: "from /settings it can be started again from any
 * terminal state"). Bumps `version` to the sequence currently in code and
 * clears the terminal timestamps - if every step still reads complete, the
 * very next `getOnboardingSnapshot` call folds it straight back to
 * `completed` with a fresh timestamp, which is the honest answer to
 * "run it again": confirmed, not re-created.
 */
export async function restartOnboarding(
  db: Db,
  identity: OnboardingIdentity,
  ctx: OnboardingContext,
): Promise<OnboardingSnapshot> {
  await upsert(db, identity, {
    status: 'in_progress',
    version: ONBOARDING_VERSION,
    startedAt: new Date(),
    completedAt: null,
    skippedAt: null,
  });
  return getOnboardingSnapshot(db, identity, ctx);
}
