// jsdom implements neither the Pointer Events capture methods nor
// `ResizeObserver`/`IntersectionObserver`, both of which bits-ui's `Select`
// (LOR-290's language-pin control) reaches for unconditionally: the trigger's
// own `onpointerdown` calls `target.hasPointerCapture(...)`, and its
// floating-ui-backed popper layer wires a `ResizeObserver` to reposition the
// open listbox. Registered as a `setupFiles` entry (vitest.config.ts) so it
// runs before a test file's own imports are evaluated - a polyfill assigned
// inside the test file itself is too late, since ES module imports (which
// pull in bits-ui and floating-ui transitively) always finish evaluating
// before that file's own top-level statements run.
//
// Guarded on `typeof window`: this file runs for every suite, including the
// node-environment ones (DB, CLI, server routes) that have no `window` at
// all, and must be a no-op there.
if (typeof window !== 'undefined') {
  const win = window as unknown as {
    ResizeObserver?: unknown;
    IntersectionObserver?: unknown;
  };
  if (typeof win.ResizeObserver === 'undefined') {
    win.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
  if (typeof win.IntersectionObserver === 'undefined') {
    win.IntersectionObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords() {
        return [];
      }
    };
  }
  const proto = Element.prototype as unknown as {
    hasPointerCapture?: (id: number) => boolean;
    setPointerCapture?: (id: number) => void;
    releasePointerCapture?: (id: number) => void;
    scrollIntoView?: () => void;
  };
  if (!proto.hasPointerCapture) proto.hasPointerCapture = () => false;
  if (!proto.setPointerCapture) proto.setPointerCapture = () => {};
  if (!proto.releasePointerCapture) proto.releasePointerCapture = () => {};
  if (!proto.scrollIntoView) proto.scrollIntoView = () => {};
}
