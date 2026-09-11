// Fixture for linkedin-boundary.test.ts (#308, rule 7). Deliberately violates
// the compliance boundary: the identical call as the allowlisted fixture
// next to it, but outside the one directory rule 7 allows. Never imported by
// real code - inert.
export async function fetchMemberSnapshot(accessToken: string): Promise<Response> {
  return fetch('https://api.linkedin.com/rest/memberSnapshotData?q=criteria', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}
