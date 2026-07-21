# Extension connection design: default to production, override for self-host and preview

Status: approved 2026-07-21. Tracking epic: **#164**. Milestone: **v1.3 - Extension hardening & connection config**.

This documents how the Chrome extension decides which Pitchbox backend it talks to, why the current behavior is broken for cloud users, and the change we are making: default to the production origin out of the box, while staying overridable for self-hosted instances and the preview environment.

## How the extension resolves its backend today

There is no concept of a "default backend" anywhere in the extension. The origin is entirely emergent from a per-origin pairing model:

- The only origin-bearing state is the `Pairing[]` array in `extension/src/lib/storage.ts`. Each pairing is `{ backendUrl, token, ... }`. The extension is already multi-backend: `api.dmSync` (`extension/src/lib/api.ts`) fans the same Reddit traffic out to every pairing, and `pickPairing()` falls back to `pairings[0]` for single-target calls.
- A pairing is created by one of two paths, both driven by the manifest:
  1. Auto-pair: the `auto-pair` content script (`extension/src/content/auto-pair.ts`) fires on a fixed origin list hardcoded in `extension/manifest.config.ts` (`content_scripts[].matches` and `host_permissions`), detects the `<meta name="pitchbox-pair">` beacon that `web/src/app.html` sets, calls `GET /api/extension/auto-pair` with the session cookie, and stores the returned device token.
  2. Manual "Pair with this tab": `ConnectionCard.svelte` reads the active tab's `location.origin`, requests a scoped runtime host permission via `chrome.permissions.request` (backed by the manifest's `optional_host_permissions: ['<all_urls>']`), then injects the same `auto-pair` script.
- There is no build-time config and no settings field for the backend. `extension/vite.config.ts` defines exactly one build-time constant (`VITE_APP_VERSION`); `extension/src/lib/settings.ts` holds theme/density/locale/sync-interval/poller toggles and nothing origin-related.

### The bug this design fixes

The manifest hardcodes `https://app.pitchbox.io` as the "cloud edition" auto-pair origin. That subdomain was never provisioned. Production DNS only serves the apex `pitchbox.app` and `www`. So the "cloud users are paired automatically" behavior documented in `docs/extension.md` and `docs/getting-started.md` has never actually run against production: a real user signed in at `https://pitchbox.app` gets no auto-pairing at all and has to discover the manual "Pair with this tab" button. This is tracked as the standalone correctness fix **#171** and ships independently of the rest of this design.

## Options considered

**A. Fix the static manifest allowlist only.** Replace `app.pitchbox.io` with `pitchbox.app` and `preview.pitchbox.app`, correct the docs, stop there. Ships in an afternoon with zero new code and no runtime permission prompt for the two known-good origins. But self-hosters and arbitrary preview subdomains still need the manual "Pair with this tab" fallback, which only works against a tab you already have open. "Default" stays an implicit array-order artifact the UI cannot label, and every new domain needs a manifest edit and a new build.

**B. Build-time default plus a settings override plus a real add-connection UI (recommended).** Keep the corrected static manifest entries for `pitchbox.app` and `preview.pitchbox.app` (this subsumes option A). On top, add a build-time `VITE_DEFAULT_BACKEND_URL` defaulting to `https://pitchbox.app`, a settings surface that shows and edits the default backend, an "Add connection" form that drives the existing `chrome.permissions.request` plus inject flow for an arbitrary URL without needing that tab open, and finally wire up the pairing-code redemption endpoint (`POST /api/extension/pair`) that is fully built server-side and has zero client callers today. Closes the self-host gap for real, gives the UI an actual "this is your default" concept, and gives admins a code-based path to pair a teammate or a headless install.

**C. Drop the static allowlist entirely.** Make every origin, including `pitchbox.app`, go through the same one-time `chrome.permissions.request` grant that self-host uses today. One code path for every deployment shape and nothing hardcoded, but it regresses the common case: the average cloud user would face a permission click on first use, worse than even today's intended zero-click behavior.

## Recommendation: Option B

Fix the manifest origin now, standalone (#171), because it is a pure correctness fix with no design dependency. Then layer on the default plus override:

- `pitchbox.app` and `preview.pitchbox.app` stay static, prompt-free auto-pair origins. MV3 gives no way to make an arbitrary runtime-typed origin default-on without either baking it into the manifest or asking once, so a small, known, closed set is the right shape for the static list.
- Everyone else (self-host, a custom preview slug, a teammate's browser) uses the settings override and the add-connection form, including code redemption.

This gives cloud users the zero-click experience option A provides for known origins, genuinely closes the self-host gap option A leaves open, and avoids the first-use regression option C introduces for the majority.

## Implementation, mapped to issues

- **#171** `fix(extension)`: replace `app.pitchbox.io` with `pitchbox.app` (and `www`) in `manifest.config.ts` and the docs. Pure fix, ship first.
- **#176** `feat(extension)`: the build-time `VITE_DEFAULT_BACKEND_URL` default, the `pitchbox.app` plus `preview.pitchbox.app` static matches, the settings override, and the "Add connection" form that also wires `POST /api/extension/pair`.
- **#172** `fix(extension)`: thread an explicit backend identifier through the dashboard-built compose URLs so `armed`/`sent` hit the right backend once multiple pairings are the common case (today they always hit `pairings[0]`).
- **#191** `fix(extension)`: make the localhost auto-pair match port-agnostic so a self-host on a non-default `WEB_PORT` still auto-pairs.
- **#199** `chore(web)`: unify `PITCHBOX_BACKEND_URL` (currently only printed in onboarding copy) with what the extension actually targets.

## Ripple effects and constraints

- **Auto-pair mechanism is untouched.** It just gains the corrected and added origins. `GET /api/extension/auto-pair` already resolves the org from the session, so no server change is needed for the origin work.
- **Pairing-code flow.** `POST /api/settings/extension-pairing` (issue a 10-minute code, admin-only) and `POST /api/extension/pair` (redeem it, public) are fully built server-side and unused by any client. Wiring them in the add-connection form is what removes the "must have a tab open on the target origin" constraint. The device-management UI that issues codes is **#177**.
- **MV3 permission ceiling does not move.** Static manifest entries are the only prompt-free path; there is no MV3 mechanism to make a dynamically-typed origin default-on. This is a documented constraint, not a limitation to design around.
- **Migration.** No cloud user has a working pairing against the intended cloud origin today, since it was never reachable, so there is no bad state to migrate. Existing self-hosted and dev pairings made via the manual button are unaffected. The only upgrade-time change is that a fresh install visiting `pitchbox.app` signed in now actually auto-pairs instead of silently doing nothing.
- **Security note.** The extension bearer token used across all of this is not yet organization-scoped on the routes that touch tenant data. That is a separate, higher-priority hardening item tracked privately (public placeholder **#170**); it is independent of the connection-origin work and does not block it.
