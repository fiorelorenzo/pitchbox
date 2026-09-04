// Fixture for linkedin-boundary.test.ts (#308, rule 3). Deliberately
// violates the compliance boundary by clicking a node obtained from the
// sibling linkedin-dom.ts stub. Inert - never imported by real code.
import { findCommentSubmitButton } from '../linkedin-dom.js';

export function submitComment(): void {
  const button = findCommentSubmitButton();
  button?.click();
}
