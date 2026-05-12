import { logger } from './logger.js';

const log = logger('insights');

// TODO(#52): real worker. Should:
//   1. Iterate active projects.
//   2. Skip projects with no draft/message activity in the last 24h.
//   3. Skip projects with a project_insights row newer than 24h.
//   4. POST to /api/run with kind='project_insights' (or analogous) to enqueue
//      a run executing the `project-insighter` playbook; the playbook calls
//      `pitchbox project:insights` to persist the result.
//
// Wired as a placeholder loop for now so the daemon ships without a broken
// import surface.
export async function startInsightsWorker(): Promise<void> {
  log.info('insights worker placeholder started (no-op until #52 lands fully)');
}
