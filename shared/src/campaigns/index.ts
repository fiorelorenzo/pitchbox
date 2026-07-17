export {
  SCENARIO_META,
  SCENARIO_SLUGS,
  AUTO_POST_PLATFORMS,
  getScenarioMeta,
  platformSupportsAutoPost,
  type ScenarioSlug,
  type ScenarioMeta,
  type ScenarioPlatformSlug,
} from './scenarios.js';

export { SCENARIO_SCHEMAS, getSchema, type CampaignProfile } from './scenario-schemas.js';

export { describeScenarioSchema } from './schema-to-prompt.js';

export { RecommendationItemSchema, type RecommendationItem } from './recommendation-schemas.js';
