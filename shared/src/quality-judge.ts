// LLM-judge quality scoring for drafts (issue #41).
//
// This module owns the rubric config (loaded from app_config.quality_rubric)
// and the UI band mapping (`scoreBand`). The actual scoring call happens
// inline at draft creation time, not here; see `createDrafts` for the runner
// invocation that consumes `loadQualityRubric` and persists the result.
import { eq } from 'drizzle-orm';
import type { Db } from './db/client.js';
import { appConfig } from './db/schema.js';

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
