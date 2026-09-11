// Fixture for linkedin-boundary.test.ts (#308, rule 7). Deliberately calls a
// linkedin.com endpoint from inside the allowlisted Data Portability
// directory - this is the one place rule 7 must let a linkedin/licdn target
// through. Never imported by real code - inert.
export async function fetchMemberSnapshot(accessToken: string): Promise<Response> {
  return fetch('https://api.linkedin.com/rest/memberSnapshotData?q=criteria', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}
