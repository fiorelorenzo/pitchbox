// Fixture for linkedin-boundary.test.ts (#308, rule 3). Stands in for
// extension/src/content/shared/linkedin-dom.ts's shape (an accessor
// returning a DOM node) without pulling in the real module. Inert.
export function findCommentSubmitButton(): HTMLButtonElement | null {
  return document.querySelector('button[type="submit"]');
}
