import { json, type RequestEvent } from '@sveltejs/kit';
import { z } from 'zod';
import { getDb } from '$lib/server/db.js';
import {
  countOrgOwners,
  findOrgBySlug,
  getMemberRole,
  removeMember,
  setMemberRole,
} from '@pitchbox/shared/orgs';

type Db = ReturnType<typeof getDb>;

const RoleBody = z.object({ role: z.enum(['owner', 'admin', 'member']) });

type Ctx = {
  db: Db;
  orgId: number;
  actorRole: string;
  targetId: number;
  targetRole: string;
};

/**
 * Resolve the actor + target and apply the shared member-management guards:
 * only owners/admins may manage members (else 404, don't leak org existence),
 * you cannot act on your own membership here, and the target must be a member.
 * Returns a `Response` to short-circuit, or the resolved context.
 */
async function resolve(event: RequestEvent): Promise<Response | Ctx> {
  const user = event.locals.user;
  if (!user) return json({ error: 'unauthenticated' }, { status: 401 });
  const db = getDb();
  const org = await findOrgBySlug(db, event.params.slug as string);
  if (!org) return json({ error: 'not_found' }, { status: 404 });
  const actorRole = await getMemberRole(db, org.id, user.id);
  if (actorRole !== 'owner' && actorRole !== 'admin') {
    return json({ error: 'not_found' }, { status: 404 });
  }
  const targetId = Number(event.params.userId);
  if (targetId === user.id) {
    return json({ error: 'You cannot change your own membership here.' }, { status: 400 });
  }
  const targetRole = await getMemberRole(db, org.id, targetId);
  if (!targetRole) return json({ error: 'not_found' }, { status: 404 });
  return { db, orgId: org.id, actorRole, targetId, targetRole };
}

export async function PATCH(event: RequestEvent) {
  const ctx = await resolve(event);
  if (ctx instanceof Response) return ctx;
  const parsed = RoleBody.safeParse(await event.request.json().catch(() => ({})));
  if (!parsed.success) return json({ error: 'invalid_body' }, { status: 400 });
  const newRole = parsed.data.role;

  // Admins cannot touch owners or grant the owner role (no privilege escalation).
  if (ctx.actorRole === 'admin' && (ctx.targetRole === 'owner' || newRole === 'owner')) {
    return json({ error: 'Only an owner can manage owners.' }, { status: 403 });
  }
  // The org must always keep at least one owner.
  if (
    ctx.targetRole === 'owner' &&
    newRole !== 'owner' &&
    (await countOrgOwners(ctx.db, ctx.orgId)) <= 1
  ) {
    return json({ error: 'The organization must keep at least one owner.' }, { status: 400 });
  }

  await setMemberRole(ctx.db, ctx.orgId, ctx.targetId, newRole);
  return json({ ok: true });
}

export async function DELETE(event: RequestEvent) {
  const ctx = await resolve(event);
  if (ctx instanceof Response) return ctx;

  // Admins cannot remove owners.
  if (ctx.actorRole === 'admin' && ctx.targetRole === 'owner') {
    return json({ error: 'Only an owner can remove an owner.' }, { status: 403 });
  }
  // The org must always keep at least one owner.
  if (ctx.targetRole === 'owner' && (await countOrgOwners(ctx.db, ctx.orgId)) <= 1) {
    return json({ error: 'The organization must keep at least one owner.' }, { status: 400 });
  }

  await removeMember(ctx.db, ctx.orgId, ctx.targetId);
  return json({ ok: true });
}
