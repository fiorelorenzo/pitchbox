import { describe, expect, it, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { getDb } from '../src/db/client.js';
import {
  MODEL_FUNCTIONS,
  clearModelFunctionCache,
  defaultModelForFunction,
  loadModelFunctionConfig,
  modelFunctionForPlaybook,
  resolveFunctionModel,
  resolveModelForRun,
  runnerTakesGatewayModel,
  saveModelFunctionModel,
} from '../src/ai/model-functions.js';
import { appConfig } from '../src/db/schema.js';

// #411: which model does which job. The properties worth defending are the
// ones a caller depends on at dispatch time, when nobody is watching: an
// unconfigured function still runs, a saved change is visible without a
// restart, and a garbage value in the jsonb does not reach the Gateway.

async function reset() {
  const db = getDb();
  await db.execute(sql`DELETE FROM app_config WHERE key = 'model_functions'`);
  clearModelFunctionCache();
}

describe('model function configuration', () => {
  beforeEach(reset);

  it('resolves an unset function to its coded default rather than throwing', async () => {
    const db = getDb();
    for (const fn of MODEL_FUNCTIONS) {
      expect(await resolveFunctionModel(db, fn)).toBe(defaultModelForFunction(fn));
    }
  });

  it('makes a saved model visible immediately, with no restart and no stale cache', async () => {
    const db = getDb();
    // Warm the cache with the default first, which is what a live deployment
    // has done long before an admin opens the form.
    expect(await resolveFunctionModel(db, 'assist_suggest')).toBe(
      defaultModelForFunction('assist_suggest'),
    );
    await saveModelFunctionModel(db, 'assist_suggest', 'anthropic/claude-haiku-4.5');
    expect(await resolveFunctionModel(db, 'assist_suggest')).toBe('anthropic/claude-haiku-4.5');
  });

  it('clearing a function goes back to the default instead of to nothing', async () => {
    const db = getDb();
    await saveModelFunctionModel(db, 'campaign_draft', 'openai/gpt-5-mini');
    expect(await resolveFunctionModel(db, 'campaign_draft')).toBe('openai/gpt-5-mini');
    await saveModelFunctionModel(db, 'campaign_draft', null);
    expect(await resolveFunctionModel(db, 'campaign_draft')).toBe(
      defaultModelForFunction('campaign_draft'),
    );
  });

  it('saving one function leaves the others alone', async () => {
    const db = getDb();
    await saveModelFunctionModel(db, 'campaign_draft', 'openai/gpt-5-mini');
    await saveModelFunctionModel(db, 'project_extract', 'anthropic/claude-sonnet-4.6');
    const config = await loadModelFunctionConfig(db);
    expect(config.campaign_draft).toBe('openai/gpt-5-mini');
    expect(config.project_extract).toBe('anthropic/claude-sonnet-4.6');
    expect(config.assist_suggest).toBeNull();
  });

  it('reads an unusable stored value as unset', async () => {
    const db = getDb();
    // jsonb holds no enum, so an older build or a hand-edited row can put
    // anything here. Sending "  " or a number to the Gateway is a failed run
    // for every tenant of that function.
    await db.insert(appConfig).values({
      key: 'model_functions',
      value: { assist_suggest: { modelId: '   ' }, campaign_draft: { modelId: 42 } },
    });
    clearModelFunctionCache();
    const config = await loadModelFunctionConfig(db);
    expect(config.assist_suggest).toBeNull();
    expect(config.campaign_draft).toBeNull();
    expect(await resolveFunctionModel(db, 'campaign_draft')).toBe(
      defaultModelForFunction('campaign_draft'),
    );
  });

  it('leaves an ACP backend alone and only hands a Gateway id to the managed runner', async () => {
    const db = getDb();
    await saveModelFunctionModel(db, 'campaign_draft', 'openai/gpt-5-mini');
    // `sonnet` and `google/gemini-3.1-flash-lite` are not the same vocabulary:
    // handing a claude-code spawn a Gateway id fails the run on a local
    // install that never asked for any of this.
    expect(runnerTakesGatewayModel('claude-code')).toBe(false);
    expect(
      await resolveModelForRun(db, { runnerSlug: 'claude-code', playbookSlug: 'hn-commenter' }),
    ).toBeUndefined();
    expect(
      await resolveModelForRun(db, { runnerSlug: 'cloud', playbookSlug: 'hn-commenter' }),
    ).toBe('openai/gpt-5-mini');
  });

  it('maps a playbook to the job it is, and an unknown slug to drafting', async () => {
    expect(modelFunctionForPlaybook('linkedin-commenter')).toBe('campaign_draft');
    expect(modelFunctionForPlaybook('reply-drafter')).toBe('campaign_draft');
    expect(modelFunctionForPlaybook('project-extractor')).toBe('project_extract');
    expect(modelFunctionForPlaybook('project-insighter')).toBe('project_insights');
    expect(modelFunctionForPlaybook('campaign-skill-generator')).toBe('skill_generate');
    // A playbook nobody mapped resolves inside a dispatch that is already
    // running, so it takes the drafting model rather than failing the run.
    expect(modelFunctionForPlaybook('some-future-playbook')).toBe('campaign_draft');
  });
});
