// Exercises shared/src/onboarding.ts: the skip/resume/restart state machine
// (#516) and the live per-step reads it is built on - a step must read the
// real thing it is about, never a stored flag of its own. Each test creates
// its own organization (+ user where relevant, unique slug/username) rather
// than reusing the seeded 'default' org, and cleans up via cascade delete on
// the org - this DB is shared across test files and teardown intentionally
// leaves data for inspection.
import { randomUUID } from 'node:crypto';
import { describe, it, expect, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '../src/db/client.js';
import { createUserRecord } from '../src/auth.js';
import { createOrganization, defaultOrgName, renameOrg } from '../src/orgs.js';
import {
  ONBOARDING_VERSION,
  computeOnboardingSteps,
  getOnboardingSnapshot,
  restartOnboarding,
  skipOnboarding,
  startOnboarding,
  type OnboardingStepId,
} from '../src/onboarding.js';

const createdOrgIds: number[] = [];
const createdUserIds: number[] = [];

afterEach(async () => {
  const db = getDb();
  while (createdOrgIds.length > 0) {
    // Cascades to memberships/projects/onboarding_state (all onDelete:
    // 'cascade' off organizations in schema.ts).
    await db.delete(schema.organizations).where(eq(schema.organizations.id, createdOrgIds.pop()!));
  }
  while (createdUserIds.length > 0) {
    await db.delete(schema.users).where(eq(schema.users.id, createdUserIds.pop()!));
  }
});

/** A fresh, self-registered-shaped org: one owner user, org named by
 * `defaultOrgName` exactly the way #513's derivation leaves it - i.e. the
 * `organization` step should read as NOT complete for this fixture until a
 * test explicitly renames it. */
async function setupOwner() {
  const db = getDb();
  const username = `onboarding-owner-${randomUUID()}`;
  const userId = await createUserRecord(db, {
    username,
    password: 'password123',
    email: `${username}@example.com`,
    emailVerifiedAt: null,
  });
  createdUserIds.push(userId);
  const org = await createOrganization(db, {
    slug: `onboarding-org-${randomUUID()}`,
    name: defaultOrgName(username),
    ownerUserId: userId,
  });
  createdOrgIds.push(org.id);
  return { orgId: org.id, userId, username };
}

async function makeProjectWithSource(orgId: number) {
  const db = getDb();
  const [project] = await db
    .insert(schema.projects)
    .values({ organizationId: orgId, slug: `p-${randomUUID()}`, name: 'Project' })
    .returning();
  await db.insert(schema.projectSources).values({
    projectId: project.id,
    kind: 'website',
    config: { url: 'https://example.com' },
    active: true,
  });
  return project.id;
}

async function makeAccount(projectId: number) {
  const db = getDb();
  const [platform] = await db
    .select({ id: schema.platforms.id })
    .from(schema.platforms)
    .where(eq(schema.platforms.slug, 'reddit'))
    .limit(1);
  const [account] = await db
    .insert(schema.accounts)
    .values({ projectId, platformId: platform.id, handle: `u-${randomUUID()}`, active: true })
    .returning();
  return { accountId: account.id, platformId: platform.id };
}

async function pairExtensionDevice(orgId: number) {
  const db = getDb();
  await db.insert(schema.extensionDevices).values({
    organizationId: orgId,
    label: 'Test device',
    tokenHash: `hash-${randomUUID()}`,
  });
}

async function makeDraft(projectId: number, accountId: number, platformId: number) {
  const db = getDb();
  const [run] = await db
    .insert(schema.runs)
    .values({ kind: 'project_extraction', projectId, trigger: 'manual', status: 'success' })
    .returning();
  await db.insert(schema.drafts).values({
    runId: run.id,
    projectId,
    platformId,
    accountId,
    kind: 'post',
    body: 'A first draft.',
  });
}

function stepById(
  steps: { id: OnboardingStepId; applicable: boolean; complete: boolean }[],
  id: OnboardingStepId,
) {
  const step = steps.find((s) => s.id === id);
  if (!step) throw new Error(`missing step ${id}`);
  return step;
}

describe('computeOnboardingSteps', () => {
  it('reads every step from real state on a fresh org: nothing applicable is complete', async () => {
    const { orgId, userId, username } = await setupOwner();
    const steps = await computeOnboardingSteps(
      getDb(),
      { organizationId: orgId, userId },
      { authOn: true, username },
    );
    expect(stepById(steps, 'organization')).toEqual({
      id: 'organization',
      applicable: true,
      complete: false,
    });
    expect(stepById(steps, 'verify_email').applicable).toBe(true);
    expect(stepById(steps, 'verify_email').complete).toBe(false);
    expect(stepById(steps, 'project').complete).toBe(false);
    expect(stepById(steps, 'account').complete).toBe(false);
    expect(stepById(steps, 'extension').complete).toBe(false);
    expect(stepById(steps, 'first_draft').complete).toBe(false);
  });

  it('the organization step reads the real name column, not a click', async () => {
    const { orgId, userId } = await setupOwner();
    await renameOrg(getDb(), orgId, 'A Real Company Name');
    const steps = await computeOnboardingSteps(
      getDb(),
      { organizationId: orgId, userId },
      { authOn: true, username: 'irrelevant-once-renamed' },
    );
    expect(stepById(steps, 'organization').complete).toBe(true);
  });

  it('the organization and verify_email steps are not applicable with auth off', async () => {
    const { orgId } = await setupOwner();
    const steps = await computeOnboardingSteps(
      getDb(),
      { organizationId: orgId, userId: null },
      { authOn: false },
    );
    expect(stepById(steps, 'organization').applicable).toBe(false);
    expect(stepById(steps, 'verify_email').applicable).toBe(false);
    // Steps that read org-level state stay applicable regardless of auth.
    expect(stepById(steps, 'project').applicable).toBe(true);
  });

  it('a project with no source does not satisfy the project step', async () => {
    const { orgId, userId } = await setupOwner();
    await getDb()
      .insert(schema.projects)
      .values({ organizationId: orgId, slug: `bare-${randomUUID()}`, name: 'Bare' });
    const steps = await computeOnboardingSteps(
      getDb(),
      { organizationId: orgId, userId },
      { authOn: true },
    );
    expect(stepById(steps, 'project').complete).toBe(false);
  });

  it('marks project/account/extension/first_draft complete once the underlying rows exist', async () => {
    const { orgId, userId } = await setupOwner();
    const projectId = await makeProjectWithSource(orgId);
    const { accountId, platformId } = await makeAccount(projectId);
    await pairExtensionDevice(orgId);
    await makeDraft(projectId, accountId, platformId);

    const steps = await computeOnboardingSteps(
      getDb(),
      { organizationId: orgId, userId },
      { authOn: true },
    );
    expect(stepById(steps, 'project').complete).toBe(true);
    expect(stepById(steps, 'account').complete).toBe(true);
    expect(stepById(steps, 'extension').complete).toBe(true);
    expect(stepById(steps, 'first_draft').complete).toBe(true);
  });

  it('a non-owner member never sees the organization step, regardless of the org name', async () => {
    const { orgId } = await setupOwner();
    const memberUsername = `onboarding-member-${randomUUID()}`;
    const memberUserId = await createUserRecord(getDb(), {
      username: memberUsername,
      password: 'password123',
      email: `${memberUsername}@example.com`,
      emailVerifiedAt: new Date(),
    });
    createdUserIds.push(memberUserId);
    await getDb()
      .insert(schema.memberships)
      .values({ organizationId: orgId, userId: memberUserId, role: 'member' });

    const steps = await computeOnboardingSteps(
      getDb(),
      { organizationId: orgId, userId: memberUserId },
      { authOn: true, username: memberUsername },
    );
    expect(stepById(steps, 'organization').applicable).toBe(false);
  });

  it("an invited member joining an already-set-up org reads completed, never repeating the owner's work", async () => {
    const { orgId } = await setupOwner();
    await renameOrg(getDb(), orgId, 'Owner Set This Up Co');
    const projectId = await makeProjectWithSource(orgId);
    const { accountId, platformId } = await makeAccount(projectId);
    await pairExtensionDevice(orgId);
    await makeDraft(projectId, accountId, platformId);

    const memberUsername = `onboarding-member-${randomUUID()}`;
    const memberUserId = await createUserRecord(getDb(), {
      username: memberUsername,
      password: 'password123',
      email: `${memberUsername}@example.com`,
      // Born verified, mirroring an invite whose named address matched -
      // see POST /api/auth/register's inviteEmailMatches branch.
      emailVerifiedAt: new Date(),
    });
    createdUserIds.push(memberUserId);
    await getDb()
      .insert(schema.memberships)
      .values({ organizationId: orgId, userId: memberUserId, role: 'member' });

    const snapshot = await startOnboarding(
      getDb(),
      { organizationId: orgId, userId: memberUserId },
      { authOn: true, username: memberUsername },
    );
    expect(snapshot.status).toBe('completed');
    expect(snapshot.currentStep).toBeNull();
  });
});

describe('the skip/resume/restart state machine', () => {
  it('a fresh identity with no row reads not_started', async () => {
    const { orgId, userId, username } = await setupOwner();
    const snapshot = await getOnboardingSnapshot(
      getDb(),
      { organizationId: orgId, userId },
      { authOn: true, username },
    );
    expect(snapshot.status).toBe('not_started');
    expect(snapshot.currentStep).toBe('organization');
  });

  it('starting moves not_started to in_progress and points at the first incomplete step', async () => {
    const { orgId, userId, username } = await setupOwner();
    const snapshot = await startOnboarding(
      getDb(),
      { organizationId: orgId, userId },
      { authOn: true, username },
    );
    expect(snapshot.status).toBe('in_progress');
    expect(snapshot.currentStep).toBe('organization');
    expect(snapshot.version).toBe(ONBOARDING_VERSION);
    expect(snapshot.startedAt).not.toBeNull();
  });

  it('resuming after progress lands on the correct next step, not the beginning', async () => {
    const { orgId, userId, username } = await setupOwner();
    await startOnboarding(getDb(), { organizationId: orgId, userId }, { authOn: true, username });
    await renameOrg(getDb(), orgId, 'Renamed Co');

    const resumed = await getOnboardingSnapshot(
      getDb(),
      { organizationId: orgId, userId },
      { authOn: true, username },
    );
    expect(resumed.status).toBe('in_progress');
    expect(stepById(resumed.steps, 'organization').complete).toBe(true);
    expect(resumed.currentStep).toBe('verify_email');
  });

  it('a pre-populated org (everything already true) starts and immediately reads completed, never a stuck in_progress with nothing to do', async () => {
    const { orgId } = await setupOwner();
    await renameOrg(getDb(), orgId, 'Already Named Co');
    const projectId = await makeProjectWithSource(orgId);
    const { accountId, platformId } = await makeAccount(projectId);
    await pairExtensionDevice(orgId);
    await makeDraft(projectId, accountId, platformId);
    // Auth off, so organization/verify_email are simply not applicable and
    // every applicable step above is already satisfied.
    const snapshot = await startOnboarding(
      getDb(),
      { organizationId: orgId, userId: null },
      { authOn: false },
    );
    expect(snapshot.status).toBe('completed');
    expect(snapshot.currentStep).toBeNull();
    expect(snapshot.completedAt).not.toBeNull();
  });

  it('starting again while already in_progress does not reset startedAt', async () => {
    const { orgId, userId, username } = await setupOwner();
    const first = await startOnboarding(
      getDb(),
      { organizationId: orgId, userId },
      { authOn: true, username },
    );
    const second = await startOnboarding(
      getDb(),
      { organizationId: orgId, userId },
      { authOn: true, username },
    );
    expect(second.startedAt?.getTime()).toBe(first.startedAt?.getTime());
  });

  it('skipping records a decision distinct from never having started', async () => {
    const { orgId, userId, username } = await setupOwner();
    await startOnboarding(getDb(), { organizationId: orgId, userId }, { authOn: true, username });
    const skipped = await skipOnboarding(
      getDb(),
      { organizationId: orgId, userId },
      { authOn: true, username },
    );
    expect(skipped.status).toBe('skipped');
    expect(skipped.skippedAt).not.toBeNull();
  });

  it('a skip survives being read again - it is server state, not a one-shot flag', async () => {
    const { orgId, userId, username } = await setupOwner();
    await startOnboarding(getDb(), { organizationId: orgId, userId }, { authOn: true, username });
    await skipOnboarding(getDb(), { organizationId: orgId, userId }, { authOn: true, username });

    const reread = await getOnboardingSnapshot(
      getDb(),
      { organizationId: orgId, userId },
      { authOn: true, username },
    );
    expect(reread.status).toBe('skipped');
  });

  it('restarting a skipped flow moves it back to in_progress', async () => {
    const { orgId, userId, username } = await setupOwner();
    await startOnboarding(getDb(), { organizationId: orgId, userId }, { authOn: true, username });
    await skipOnboarding(getDb(), { organizationId: orgId, userId }, { authOn: true, username });

    const restarted = await restartOnboarding(
      getDb(),
      { organizationId: orgId, userId },
      { authOn: true, username },
    );
    expect(restarted.status).toBe('in_progress');
    expect(restarted.skippedAt).toBeNull();
  });

  it('a completed flow can be run again and creates nothing twice', async () => {
    const { orgId, userId, username } = await setupOwner();
    await renameOrg(getDb(), orgId, 'Done Co');
    const projectId = await makeProjectWithSource(orgId);
    const { accountId, platformId } = await makeAccount(projectId);
    await pairExtensionDevice(orgId);
    await makeDraft(projectId, accountId, platformId);
    // Verify the email too, so every applicable step is genuinely satisfied.
    await getDb()
      .update(schema.users)
      .set({ emailVerifiedAt: new Date() })
      .where(eq(schema.users.id, userId!));

    const completedOnce = await startOnboarding(
      getDb(),
      { organizationId: orgId, userId },
      { authOn: true, username },
    );
    expect(completedOnce.status).toBe('completed');

    const [projectsBefore, draftsBefore] = await Promise.all([
      getDb().select().from(schema.projects).where(eq(schema.projects.organizationId, orgId)),
      getDb()
        .select()
        .from(schema.drafts)
        .innerJoin(schema.projects, eq(schema.projects.id, schema.drafts.projectId))
        .where(eq(schema.projects.organizationId, orgId)),
    ]);

    const restarted = await restartOnboarding(
      getDb(),
      { organizationId: orgId, userId },
      { authOn: true, username },
    );
    // Immediately re-completes, since every applicable step already reads true.
    expect(restarted.status).toBe('completed');

    const [projectsAfter, draftsAfter] = await Promise.all([
      getDb().select().from(schema.projects).where(eq(schema.projects.organizationId, orgId)),
      getDb()
        .select()
        .from(schema.drafts)
        .innerJoin(schema.projects, eq(schema.projects.id, schema.drafts.projectId))
        .where(eq(schema.projects.organizationId, orgId)),
    ]);
    expect(projectsAfter.length).toBe(projectsBefore.length);
    expect(draftsAfter.length).toBe(draftsBefore.length);
  });

  it('a second completion after restarting is a real, distinct transition (skipped -> in_progress -> completed)', async () => {
    const { orgId, userId, username } = await setupOwner();
    await startOnboarding(getDb(), { organizationId: orgId, userId }, { authOn: true, username });
    await skipOnboarding(getDb(), { organizationId: orgId, userId }, { authOn: true, username });

    await renameOrg(getDb(), orgId, 'Second Pass Co');
    const projectId = await makeProjectWithSource(orgId);
    const { accountId, platformId } = await makeAccount(projectId);
    await pairExtensionDevice(orgId);
    await makeDraft(projectId, accountId, platformId);
    await getDb()
      .update(schema.users)
      .set({ emailVerifiedAt: new Date() })
      .where(eq(schema.users.id, userId!));

    const restarted = await restartOnboarding(
      getDb(),
      { organizationId: orgId, userId },
      { authOn: true, username },
    );
    expect(restarted.status).toBe('completed');
    expect(restarted.completedAt).not.toBeNull();
  });

  it('skipping is a no-op once already completed', async () => {
    const { orgId } = await setupOwner();
    const projectId = await makeProjectWithSource(orgId);
    const { accountId, platformId } = await makeAccount(projectId);
    await pairExtensionDevice(orgId);
    await makeDraft(projectId, accountId, platformId);
    // Auth off for this identity, so the org/email steps are inapplicable
    // and every applicable step above is satisfied.
    const completed = await startOnboarding(
      getDb(),
      { organizationId: orgId, userId: null },
      { authOn: false },
    );
    expect(completed.status).toBe('completed');
    const afterSkip = await skipOnboarding(
      getDb(),
      { organizationId: orgId, userId: null },
      { authOn: false },
    );
    expect(afterSkip.status).toBe('completed');
    expect(afterSkip.skippedAt).toBeNull();
  });
});

describe('self-host identity (no user row)', () => {
  it('a null-user row is keyed on the org alone and survives a re-read', async () => {
    const db = getDb();
    const org = await db
      .insert(schema.organizations)
      .values({ slug: `onboarding-selfhost-${randomUUID()}`, name: 'Self-host' })
      .returning();
    createdOrgIds.push(org[0].id);

    const started = await startOnboarding(
      db,
      { organizationId: org[0].id, userId: null },
      { authOn: false },
    );
    expect(started.status).toBe('in_progress');

    const rows = await db
      .select()
      .from(schema.onboardingState)
      .where(eq(schema.onboardingState.organizationId, org[0].id));
    expect(rows).toHaveLength(1);
    expect(rows[0].userId).toBeNull();

    const reread = await getOnboardingSnapshot(
      db,
      { organizationId: org[0].id, userId: null },
      { authOn: false },
    );
    expect(reread.status).toBe('in_progress');
  });
});
