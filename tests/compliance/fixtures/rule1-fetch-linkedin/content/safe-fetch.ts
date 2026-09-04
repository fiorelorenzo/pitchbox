// Sibling fixture proving rule 1 only flags fetch targets that mention
// linkedin/licdn - a fetch toward Pitchbox's own backend must stay clean.
export async function pingBackend(): Promise<Response> {
  return fetch('https://pitchbox.app/api/health');
}
