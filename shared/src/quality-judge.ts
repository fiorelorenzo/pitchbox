// LLM-judge quality scoring for drafts (issue #41).
//
// V1 ships with a deterministic stub scorer so the surrounding plumbing
// (schema, CLI command, UI badge, persistence path) can land independently of
// a real runner call. The stub returns a stable score derived from the draft
// body length + reasoning so tests are reproducible.
//
// TODO: replace `runStubJudge` with a real runner invocation that consumes
// `quality_rubric.rubric_template` from app_config and parses the JSON output
// `{score, reason, model}` returned by the LLM judge.
import { eq } from 'drizzle-orm';
import type { Db } from './db/client.js';
import { drafts, appConfig, draftEvents } from './db/schema.js';

export interface QualityRubric {
  rubric_template: string;
  threshold_red: number;
  threshold_green: number;
}

export const DEFAULT_QUALITY_RUBRIC: QualityRubric = {
  rubric_template:
    'Score the following outreach draft from 0-100 on these axes (clarity, relevance, personalization, tone). Return JSON {"score": number, "reason": string}.',
  threshold_red: 40,
  threshold_green: 75,
};

export interface JudgeResult {
  score: number;
  reason: string;
  model: string;
}

export interface JudgeRunner {
  // The runner takes a rubric + draft body/title and returns a score.
  score: (input: {
    rubricTemplate: string;
    body: string;
    title?: string | null;
  }) => Promise<JudgeResult>;
}

// Deterministic stub used by V1. Hashes the body+title into a 0-100 range so
// tests can assert exact persistence behaviour without a real LLM.
export function stubJudgeRunner(model = 'stub-judge-v1'): JudgeRunner {
  return {
    async score({ body, title }) {
      const text = `${title ?? ''}|${body}`;
      // Bias toward the middle of the range, then nudge by simple heuristics so
      // longer / more specific bodies trend higher.
      let hash = 0;
      for (let i = 0; i < text.length; i += 1) {
        hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
      }
      const base = hash % 60; // 0..59
      const lengthBonus = Math.min(40, Math.floor(text.length / 20));
      const score = Math.max(0, Math.min(100, base + lengthBonus));
      return {
        score,
        reason: `stub-judge: length=${text.length} base=${base} bonus=${lengthBonus}`,
        model,
      };
    },
  };
}

export async function loadQualityRubric(db: Db): Promise<QualityRubric> {
  const [row] = await db.select().from(appConfig).where(eq(appConfig.key, 'quality_rubric'));
  if (!row) return { ...DEFAULT_QUALITY_RUBRIC };
  const v = row.value as Partial<QualityRubric>;
  return {
    rubric_template:
      typeof v.rubric_template === 'string'
        ? v.rubric_template
        : DEFAULT_QUALITY_RUBRIC.rubric_template,
    threshold_red:
      typeof v.threshold_red === 'number' ? v.threshold_red : DEFAULT_QUALITY_RUBRIC.threshold_red,
    threshold_green:
      typeof v.threshold_green === 'number'
        ? v.threshold_green
        : DEFAULT_QUALITY_RUBRIC.threshold_green,
  };
}

export interface ScoreDraftResult {
  draftId: number;
  score: number;
  reason: string;
  model: string;
}

export async function scoreDraft(
  db: Db,
  draftId: number,
  runner: JudgeRunner = stubJudgeRunner(),
): Promise<ScoreDraftResult> {
  const [d] = await db.select().from(drafts).where(eq(drafts.id, draftId));
  if (!d) throw new Error(`draft ${draftId} not found`);
  const rubric = await loadQualityRubric(db);
  const judged = await runner.score({
    rubricTemplate: rubric.rubric_template,
    body: d.body,
    title: d.title,
  });
  const clamped = Math.max(0, Math.min(100, Math.round(judged.score)));
  await db
    .update(drafts)
    .set({
      qualityScore: clamped,
      qualityReason: judged.reason,
      qualityModel: judged.model,
    })
    .where(eq(drafts.id, draftId));
  await db.insert(draftEvents).values({
    draftId,
    event: 'scored',
    actor: 'system',
    details: { score: clamped, model: judged.model },
  });
  return { draftId, score: clamped, reason: judged.reason, model: judged.model };
}

// Map a numeric score to a UI band given the configured rubric thresholds.
export function scoreBand(
  score: number | null | undefined,
  rubric: QualityRubric,
): 'red' | 'amber' | 'green' | 'none' {
  if (score == null) return 'none';
  if (score < rubric.threshold_red) return 'red';
  if (score >= rubric.threshold_green) return 'green';
  return 'amber';
}
