// The violation under test: a storage read inside a LinkedIn content script.
export function readSomething(): string | null {
  return localStorage.getItem('li_at');
}
