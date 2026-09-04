// Fixture for linkedin-boundary.test.ts (#308, rule 5). Stands in for a file
// under shared/src/platforms/linkedin/ that performs a network call, which
// that directory must never do (parsing and mapping only). The URL need not
// mention "linkedin" - being under that directory is what makes any network
// call a violation. Inert - never imported by real code.
export async function fetchProfile(urn: string): Promise<unknown> {
  const res = await fetch(`https://example.com/profile/${urn}`);
  return res.json();
}
