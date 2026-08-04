// Browser-safe barrel: Svelte components import it (e.g. the campaign page uses
// platformSupportsAutoPost), so nothing re-exported here may reach `db/client`.
// Pulling drizzle/pg into the client bundle breaks the page at hydration with
// "Buffer is not defined". DB-touching campaign helpers live in ./server.ts and
// ship under the `@pitchbox/shared/campaigns/server` subpath instead.

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
