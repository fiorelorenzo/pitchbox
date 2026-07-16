// Shared harness for driving a request through the REAL
// `web/src/hooks.server.ts` `handle()` hook before invoking a route handler,
// instead of hand-fabricating `event.locals.org`. Hand-injecting locals.org
// is exactly what let the /api/auth/unlock + /api/auth/failures role-gate bug
// hide (#132 / ISO-1): the hook's `isExemptPath` list wrongly exempted those
// routes from session + org/role resolution, so `requireRole` had nothing to
// gate on in production, yet the tests passed because they injected
// `locals.org` by hand and never went through the hook at all.

export type CookieJar = {
  store: Map<string, { value: string; expires?: Date }>;
};

export function makeCookies(jar: CookieJar) {
  return {
    get: (name: string) => jar.store.get(name)?.value,
    set: (name: string, value: string, opts?: { expires?: Date }) => {
      jar.store.set(name, { value, expires: opts?.expires });
    },
    delete: (name: string) => {
      jar.store.delete(name);
    },
    getAll: () => Array.from(jar.store.entries()).map(([name, v]) => ({ name, value: v.value })),
    serialize: () => '',
  };
}

// hooks.server.ts reads PITCHBOX_AUTH into a module-level constant at import
// time, so it must be `on` before the module is (dynamically) imported - a
// static top-of-file import would evaluate before a test's beforeEach runs.
// Cached after the first call: vitest gives each test file its own isolated
// module registry, so this cache never leaks the `on` env value across files,
// but every call within the same file returns the same handle + captured env.
let handlePromise: Promise<typeof import('../../src/hooks.server.js').handle> | undefined;

export function getRealHandle(): Promise<typeof import('../../src/hooks.server.js').handle> {
  if (!handlePromise) {
    process.env.PITCHBOX_AUTH = 'on';
    handlePromise = import('../../src/hooks.server.js').then((m) => m.handle);
  }
  return handlePromise;
}

// Drives a request through the real `handle()` hook (the actual
// exempt-path + session + org/role resolution code path), then hands off to
// the real route handler with whatever `event.locals` the hook populated.
export async function runThroughHandle(
  request: Request,
  jar: CookieJar,
  routeHandler: (event: unknown) => Promise<Response>,
  ip = '10.0.0.2',
): Promise<Response> {
  const event = {
    request,
    url: new URL(request.url),
    cookies: makeCookies(jar) as any,
    locals: {} as any,
    getClientAddress: () => ip,
  };
  const handle = await getRealHandle();
  return await handle({
    event: event as any,
    resolve: async (ev: typeof event) => routeHandler(ev),
  } as any);
}
