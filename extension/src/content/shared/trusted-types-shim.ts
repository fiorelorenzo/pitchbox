/**
 * Lets a Svelte-rendered content script boot on a page that ships a
 * `trusted-types` CSP allowlist, which LinkedIn does.
 *
 * Svelte's client runtime creates a Trusted Types policy while its module is
 * evaluating (`trustedTypes.createPolicy('svelte-trusted-html')`). A content
 * script runs in an isolated world and is exempt from the page's CSP for DOM
 * sinks, but Chrome still applies the page's **policy-name allowlist** to
 * `createPolicy` there, so on linkedin.com that call throws
 *
 *   TypeError: Failed to execute 'createPolicy' on
 *   'TrustedTypePolicyFactory': Policy "svelte-trusted-html" disallowed.
 *
 * The throw lands mid module graph, so it takes the whole script down before
 * anything mounts: measured on a real signed-in post page, where the in-page
 * assistant simply never appeared and the only trace was one uncaught
 * exception (#379).
 *
 * So `createPolicy` is wrapped, in this world only, to fall back to an
 * identity policy when the real factory refuses the name. The strings it
 * returns are then assigned by Svelte to the same sinks it would have used
 * anyway, which the isolated world already permits. The page is unaffected:
 * its own realm keeps its own untouched factory, and nothing here creates a
 * policy the page can reach.
 *
 * Imported first by every panel-bearing content script, because the patch has
 * to be installed before Svelte's runtime module is evaluated. The DOM lib in
 * use has no Trusted Types definitions, hence the local structural types.
 */

type PolicyOptions = {
  createHTML?: (input: string) => string;
  createScript?: (input: string) => string;
  createScriptURL?: (input: string) => string;
};

type PolicyLike = {
  name: string;
  createHTML: (input: string) => string;
  createScript: (input: string) => string;
  createScriptURL: (input: string) => string;
};

export type PolicyFactoryLike = {
  createPolicy: (name: string, options?: PolicyOptions) => PolicyLike;
};

/** Named rather than inline: `globalThis` has no `trustedTypes` in this TS lib,
 * and a browser that predates Trusted Types has none at runtime either. */
const globalWithTrustedTypes = globalThis as unknown as { trustedTypes?: PolicyFactoryLike };

/** Same call surface, no sanitisation: exactly what Svelte's own policy does
 * with the template strings it built itself. */
function identityPolicy(name: string, options?: PolicyOptions): PolicyLike {
  return {
    name,
    createHTML: (input) => options?.createHTML?.(input) ?? input,
    createScript: (input) => options?.createScript?.(input) ?? input,
    createScriptURL: (input) => options?.createScriptURL?.(input) ?? input,
  };
}

/**
 * Wraps `factory.createPolicy` so a refused policy name yields an identity
 * policy instead of throwing. A policy the factory accepts is returned
 * untouched. Exported so it can be tested directly; the call below is what
 * matters at runtime, since it must happen on import.
 */
export function installTrustedTypesFallback(
  factory: PolicyFactoryLike | undefined = globalWithTrustedTypes.trustedTypes,
): void {
  if (!factory || typeof factory.createPolicy !== 'function') return;
  const original = factory.createPolicy.bind(factory);
  factory.createPolicy = (name, options) => {
    try {
      return original(name, options);
    } catch {
      return identityPolicy(name, options);
    }
  };
}

installTrustedTypesFallback();
