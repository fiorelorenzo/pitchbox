// Fixture for linkedin-boundary.test.ts (#308, rule 4). A LinkedIn code path
// reached from the sibling background.ts's chrome.alarms handler. Inert.
export async function pollFromLinkedin(): Promise<void> {
  // Stand-in for background polling of a LinkedIn endpoint - the pattern
  // rule 4 forbids regardless of what this function actually does.
}
