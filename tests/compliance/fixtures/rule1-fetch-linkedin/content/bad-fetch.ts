// Fixture for linkedin-boundary.test.ts (#308, rule 1). Deliberately violates
// the compliance boundary. Never imported by real extension code - inert.
export async function pollLinkedInFeed(): Promise<Response> {
  return fetch('https://www.linkedin.com/voyager/api/feed/updates');
}
