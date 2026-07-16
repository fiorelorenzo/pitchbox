# CI/CD deploy design

Design for automated deploys of Pitchbox to the production box (`prodbox`, the
Netcup VPS at `152.53.44.195`). Two environments run side by side on that one host
with identical deploy mechanics: **prod** (`pitchbox.app`, deployed on release
tags) and **preview** (`preview.pitchbox.app`, deployed on every green push to
`main`). Deploys are blue-green with automatic rollback.

Status: shipped 2026-07-10 and in production use. `deploy-prod.yml` and
`deploy-preview.yml` have deployed six tagged releases (`v0.6.0` through
`v0.9.0`) to `pitchbox.app` and `preview.pitchbox.app` since. A few hardening
items from the original design are still open - see "Repo changes" below.

## Goals

- Push a release tag, get it live on `pitchbox.app` with no manual steps.
- Every green `main` gets a running preview on `preview.pitchbox.app` against an
  isolated database, so I can click through a change before tagging it.
- Zero downtime on the web tier during a deploy, and an automatic rollback if the
  new version does not come up healthy.
- Keep the security posture we just built: prodbox SSH stays Tailscale-only, no
  new inbound ports.

## Why a self-hosted runner

prodbox is reachable over SSH only through Tailscale, so a GitHub-hosted runner
cannot reach it without either exposing SSH publicly or shipping a Tailscale auth
key into GitHub secrets. Both add attack surface for no real benefit. A
**self-hosted GitHub Actions runner running on prodbox** connects outbound to
GitHub, so it needs no inbound access at all. It also sits where the two private
nested repos (`cloud/adapter`, `cloud/runner`) and the large Chrome-bearing image
already live, which removes the need to push a multi-GB image through a registry.
Self-hosted runners are only risky for public repos (they run untrusted PR code);
`fiorelorenzo/pitchbox` is private, so the only code that runs is ours.

## The two environments

Both run on prodbox, fully isolated by a distinct Compose project (`-p`), its own
directory, its own `.env`, its own ports, and its own Postgres volume. The deploy
logic is identical; only the trigger, the domain, and the isolation namespace
differ.

|                        | prod                               | preview                             |
| ---------------------- | ---------------------------------- | ----------------------------------- |
| Domain                 | `pitchbox.app`                     | `preview.pitchbox.app`              |
| Trigger                | push of a tag `v*`                 | push to `main`, only if CI is green |
| Gate                   | direct (main was vetted on the PR) | CI checks must pass first           |
| Compose project        | `pitchbox`                         | `pitchbox-preview`                  |
| Directory              | `/opt/apps/pitchbox`               | `/opt/apps/pitchbox-preview`        |
| Web ports (blue/green) | 5180 / 5181                        | 5190 / 5191                         |
| Postgres volume        | `pitchbox_pitchbox-pg-data`        | `pitchbox-preview_pitchbox-pg-data` |
| `.env`                 | own, incl. own `ENCRYPTION_KEY`    | own, incl. own `ENCRYPTION_KEY`     |
| Stack                  | postgres + web + daemon + runner   | same, full stack                    |
| Auth                   | `PITCHBOX_AUTH=on`                 | `PITCHBOX_AUTH=on`                  |

Preview is a full clone of prod, daemon included. Its database starts empty and
isolated (migrations plus `seed:core` only, no copy of prod data), so the daemon
has no accounts or campaigns to act on and stays inert until someone connects a
Reddit account inside preview. See the caveats: once you do, preview posts to
Reddit for real.

## Authentication

Both environments run with **`PITCHBOX_AUTH=on`** in their `.env`. Pitchbox ships
unauthenticated by default (single-user self-host), which is fine on a private box
but not for two internet-facing hostnames, and it matters most for preview since
that URL is public and its database is fresh.

With auth on, `hooks.server.ts` requires a valid `pitchbox_session` cookie:
HTML navigations without one redirect to `/login`, `/api/*` calls return `401`.
The catch is the first-run bootstrap: on an empty `users` table the initial owner
account is created by the first authenticated setup, so each fresh environment must
have its owner claimed (or seeded) before the URL is shared. Two consequences the
deploy must respect:

- **Claim the owner account immediately after a fresh deploy, before sharing the
  URL.** This applies to any environment whose `users` table is empty, so above all
  to preview (rebuilt on every green `main`, but note the Postgres volume persists
  across preview deploys, so the user only needs claiming once per volume lifetime,
  not every deploy).
- If Pitchbox later grows a seed for an initial admin user, the deploy should seed
  the owner from env credentials to close the bootstrap window entirely. Until then,
  claiming manually right after the first deploy is the mitigation.

## Repo changes (in `fiorelorenzo/pitchbox`)

Shipped:

1. **`cloud/adapter` and `cloud/runner` are git submodules** of the umbrella,
   pinned to specific commits (`.gitmodules`). A tag fully describes what runs,
   and `git submodule update --init --recursive` fetches everything. They are no
   longer independent gitignored repos.
2. **The Compose overlays are committed**, so the pipeline runs off files tracked
   in the repo rather than files that only exist on the box:
   - `docker-compose.app.runner.yml`: the co-located runner service plus the web
     `ORIGIN`.
   - `docker-compose.bluegreen.yml`: defines the two web colors and their ports
     (see below).
   - `docker-compose.preview.yml`: preview-only overrides (ports, no host-published
     Postgres port to avoid clashing with prod's `5434`).
3. **The workflows are in place**: `.github/workflows/deploy-prod.yml` (`on: push:
tags: ['v*']`) and `.github/workflows/deploy-preview.yml`, which deploys on a
   green `main` via a `workflow_run` trigger keyed to the `CI` workflow completing
   successfully - the opposite of what this doc originally proposed (see the note
   in "Preview specifics").

Still pending (tracked as separate issues; none of them block the pipeline from
running, they narrow gaps in its safety net):

- **Image-tagged rollback (#108).** The image is still built and run under the one
  shared `pitchbox-app:latest` tag (`docker-compose.bluegreen.yml`), with no
  per-ref tag and no pruning, so the "point `APP_IMAGE` at the previous release"
  rollback described below is not actually possible yet.
- **`PITCHBOX_AUTH` default (#110).** `docker-compose.bluegreen.yml` and
  `docker-compose.app.runner.yml` both default `PITCHBOX_AUTH` to `off`, and
  `.env.docker.example` does not document the var. Today's live hosts are correct
  only because a human set it by hand; nothing in the repo enforces or prompts it
  for the next fresh environment.
- **Backup before migrate (#111).** `scripts/deploy.sh` has no `pg_dump` step, so
  a bad migration still needs a manual restore rather than a scripted one (see
  caveats below).
- **Seed the owner from env (#109).** No `pitchbox seed:owner` (or equivalent)
  exists yet. The first-run bootstrap window described below is closed by
  claiming the owner manually right after a fresh deploy, not by an automated
  seed step.

## Deploy pipeline (identical for both environments)

Both workflows `runs-on: [self-hosted, prodbox]` and call one shared deploy script
(`scripts/deploy.sh <env>`), parameterised by environment. `<env>` selects the
directory, Compose project name, `.env`, port pair, and Caddy upstream file.

```
1. checkout the ref (tag for prod, main SHA for preview) with --recurse-submodules
2. rsync the checkout into the env dir, excluding .env and .git
3. build the image, tagged pitchbox-app:<ref> and :<env>-latest
   (previous :<env>-latest stays as the rollback reference)
4. read the currently active web color from the env's Caddy upstream file;
   the target is the idle color
5. start the idle web color with the new image (compose up -d --no-build web-<idle>)
6. health-check the idle color directly on its own port until healthy, or time out
      -> on timeout: leave the active color serving, fail the job (no cutover, no downtime)
7. run migrations: compose exec web-<idle> pnpm -F @pitchbox/shared migrate (+ seed:core)
8. flip Caddy: write reverse_proxy 127.0.0.1:<idle-port> into the env upstream file,
   systemctl reload caddy (graceful, zero-downtime)
9. smoke-check the public URL (https://<domain>/)
      -> on failure: flip Caddy back to the still-running old color, stop the idle
         color, restore :<env>-latest to the previous image, fail the job (auto-rollback)
10. recreate the daemon (singleton) pointing PITCHBOX_WEB_URL at the new color;
    recreate the runner keeping the old one until the new one is healthy
11. stop and remove the old web color
12. prune images beyond the last N per env
```

### Blue-green on the web tier

The web tier runs as two services, `web-blue` (port 5180 for prod, 5190 for
preview) and `web-green` (5181 / 5191), defined in `docker-compose.bluegreen.yml`.
Both use the same built image and the same environment. At any moment only one
color is "active", meaning Caddy points its upstream at that color's port. A deploy
brings up the idle color, proves it healthy on its own port, flips Caddy, and only
then retires the previously active color. Because Caddy's `reload` drains
connections gracefully, the cutover has no dropped requests.

Caddy learns the active upstream from a per-environment include file that the deploy
script rewrites:

```
# /etc/caddy/Caddyfile
pitchbox.app {
    encode zstd gzip
    import /etc/caddy/upstreams/prod.conf
}
preview.pitchbox.app {
    encode zstd gzip
    import /etc/caddy/upstreams/preview.conf
}
# /etc/caddy/upstreams/prod.conf  ->  reverse_proxy 127.0.0.1:5180
```

That file is the single source of truth for which color is live, so the deploy
script derives active and idle colors by reading it, with no separate state to
drift.

### Daemon and runner cutover

The daemon is not blue-green. It is a singleton scheduler and reply poller, and
running two copies at once risks posting duplicate Reddit replies. So at cutover it
is a clean stop-old, start-new, which leaves a gap of a few seconds where no daemon
runs. That gap is harmless for a background poller. The new daemon starts with
`PITCHBOX_WEB_URL` pointing at the newly active web color.

The runner is stateless (a WebSocket compute service, no DB, no user data). It does
not need blue-green, but to avoid a gap in agent runs the deploy starts the new
runner and waits for its `/health` before removing the old one.

### Auto-rollback

Rollback is automatic and image-level, not database-level.

- **Before the Caddy flip:** if the idle color never becomes healthy, the deploy
  never cuts over. The active color keeps serving, the job fails. This is the safe
  default and has zero downtime.
- **After the Caddy flip:** if the public smoke check fails, the deploy flips Caddy
  back to the previous color (still running, so the revert is instant), stops the
  new color, and restores the `:<env>-latest` tag to the previous image. The job
  fails.
- The old color is kept running for a short window after the flip specifically so
  this revert is instant.

Database migrations are forward-only. A bad migration is not auto-rolled-back, and
recovering from one needs manual work (a down migration or a restore). See caveats.

## Preview specifics

- **Trigger and gate:** preview deploys on push to `main` only after the CI checks
  pass. This doc originally proposed a `push: branches: [main]` trigger with its
  own `test` job, and rejected a `workflow_run` trigger as more moving parts for no
  real gain. What actually shipped is the opposite: `deploy-preview.yml` uses
  `on: workflow_run: { workflows: ['CI'], types: [completed], branches: [main] }`
  and only runs its `deploy` job `if: github.event.workflow_run.conclusion ==
'success'`, checking out `github.event.workflow_run.head_sha`. That keeps `ci.yml`
  as the single source of truth for "is this commit green" instead of duplicating a
  test job in the deploy workflow.
- **Isolation:** everything is namespaced by the `pitchbox-preview` Compose project
  and the `/opt/apps/pitchbox-preview` directory, so containers, network, and the
  Postgres volume are separate from prod. Preview never touches the prod database.
- **Ports:** `docker-compose.preview.yml` moves the web colors to 5190/5191 and
  drops the host-published Postgres port (prod already binds `127.0.0.1:5434`;
  preview reaches Postgres over its own Compose network, so it needs no host port).

## One-time setup on prodbox

1. **Install the GitHub Actions runner** as a systemd service, running as a
   dedicated non-root user that is in the `docker` group, registered to
   `fiorelorenzo/pitchbox` with the label `prodbox`. Registration uses a one-time
   token from the repo's Actions settings.
2. **Give the runner read access to the private submodules.** A deploy key per
   submodule repo, or one fine-grained PAT with read-only contents on both
   `cloud/adapter` and `cloud/runner`, configured in the box's git credentials so
   `checkout --recurse-submodules` works.
3. **Create the preview `.env`** at `/opt/apps/pitchbox-preview/.env` with its own
   generated `ENCRYPTION_KEY` and `RUNNER_TOKEN`, `ORIGIN=https://preview.pitchbox.app`,
   `PITCHBOX_AUTH=on`, and the preview ports. Reuse or mint a separate runner OAuth
   token, my call. Also add `PITCHBOX_AUTH=on` to the existing prod `.env`
   (`/opt/apps/pitchbox/.env`), which currently lacks it: the running prod at
   `pitchbox.app` is unauthenticated today and must have auth turned on (a `.env`
   edit plus a web recreate), independently of the rest of this rollout.
4. **DNS:** add `preview.pitchbox.app` as an A record to `152.53.44.195`,
   DNS-only (grey cloud), via the Cloudflare token already on the devbox.
5. **Caddy:** add the `preview.pitchbox.app` vhost and the two upstream include
   files, seeded to the starting color for each env.

Secrets never enter git or GitHub. Each env's `.env` lives on prodbox and persists
across deploys (the rsync in step 2 of the pipeline excludes it). The only secrets
GitHub holds are the runner registration and the submodule read credential.

## Resource management

prodbox is 4 cores and 8 GB. Two full stacks, each briefly running three web
containers during a blue-green cutover, plus two Chrome-capable daemons and two
runners, is heavy. Two measures keep it safe:

- **Per-environment memory limits** on web, daemon, and runner (the prod overlay
  already sets `WEB_MEM_LIMIT`, `DAEMON_MEM_LIMIT`; preview gets the same or lower).
- **Serialized deploys:** a single shared GitHub Actions concurrency group across
  both workflows, so a prod deploy and a preview deploy never build or cut over at
  the same time. The 7.9 GB of swap (zram plus swapfile) absorbs build spikes.

## Rollback (manual)

Beyond the automatic rollback inside a failed deploy, a manual rollback is: point
the env at a previous image and flip. Since images are tagged `pitchbox-app:<ref>`,
this is setting `APP_IMAGE=pitchbox-app:<previous-ref>` and running the deploy
script's cutover against the already-built image, or re-running the deploy workflow
on the previous tag. The last N images per env are kept for exactly this.

## Caveats and limitations

1. **Migrations must be backward-compatible (expand-contract).** During the
   blue-green overlap the old web runs for a few seconds against the already-migrated
   schema. A destructive migration breaks it. The database is forward-only, so a bad
   migration is not auto-rolled-back and needs manual recovery. This is the real
   boundary of "zero downtime" here, and it is a discipline on how migrations are
   written, not something the pipeline can enforce.
2. **Preview acts on the real world if you let it.** Its isolated database starts
   empty, so the daemon is inert, but the moment a real Reddit account is connected
   in preview, preview's daemon posts real replies. Treat preview accounts with the
   same care as prod.
3. **The box is small.** Two identical full stacks on 4 cores and 8 GB is the main
   operational risk. Memory limits and serialized deploys mitigate it; sustained
   heavy scraping in both environments at once will still be slow.

## Out of scope (YAGNI)

- Re-running the test suite on prod tags. Tags are cut from already-green `main`;
  the deploy is gated by the build succeeding and the post-deploy health check.
- Blue-green for the daemon. It must be a singleton.
- Deploy notifications (Slack, email). Add later if wanted.
- A separate staging host. Preview lives on the same box by design.

## Prerequisites (gathered for the initial rollout)

All of these were needed once, to stand the pipeline up; kept here for reference,
not as an open TODO.

- The GitHub URLs of the `cloud/adapter` and `cloud/runner` repos, to wire the
  submodules.
- A GitHub self-hosted runner registration token for `fiorelorenzo/pitchbox`.
- A read-only credential (two deploy keys, or one fine-grained PAT) for the two
  submodule repos.
- The name of the existing CI workflow, to gate preview via `workflow_run` (this
  is the mechanism that shipped - see "Preview specifics").
