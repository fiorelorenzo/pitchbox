// Test-only stand-in for SvelteKit's `$app/navigation`, aliased in
// `vitest.config.ts` for the same reason as `./app-stores.ts`: no
// `sveltejs/kit` Vite plugin is wired into the root config, so the real
// module never resolves under a mounted-component test. `invalidateAll` and
// `goto` are `vi.fn()` so a test can assert a component called them without
// driving a real SvelteKit router.
import { vi } from 'vitest';

export const invalidateAll = vi.fn(async () => {});
export const goto = vi.fn(async () => {});
