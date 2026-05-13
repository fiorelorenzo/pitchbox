// Helpers for the few-shot `templates` resource. Templates are scoped to a
// project and a kind ('dm' | 'comment' | 'post'). They are surfaced to
// playbooks via `pitchbox run:start` so the agent can ground drafts in
// project-specific voice without baking examples into the playbook body.

import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { and, asc, eq } from 'drizzle-orm';
import * as schema from './db/schema.js';

export type TemplateKind = 'dm' | 'comment' | 'post';

export type Template = typeof schema.templates.$inferSelect;

export interface LoadActiveTemplatesOpts {
  projectId: number;
  kind?: TemplateKind;
  /** Reserved for campaign-level overrides; currently ignored (V1). */
  campaignId?: number;
}

/**
 * Returns active (non-archived) templates for a project, optionally filtered
 * by `kind`. Campaign-level overrides are not yet wired in V1 - when the
 * `campaign_overrides` jsonb column lands on `campaigns`, this loader will
 * prefer those over the project-level rows.
 */
export async function loadActiveTemplates(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: NodePgDatabase<typeof schema> | any,
  opts: LoadActiveTemplatesOpts,
): Promise<Template[]> {
  const where = opts.kind
    ? and(
        eq(schema.templates.projectId, opts.projectId),
        eq(schema.templates.kind, opts.kind),
        eq(schema.templates.isActive, true),
      )
    : and(eq(schema.templates.projectId, opts.projectId), eq(schema.templates.isActive, true));

  return db.select().from(schema.templates).where(where).orderBy(asc(schema.templates.createdAt));
}
