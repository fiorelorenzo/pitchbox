---
name: pitchbox-cloud-submodules
description: Use when committing, branching, or landing a change inside the cloud/runner or cloud/adapter private submodules, or when editing the shared cloud protocol contract (shared/src/agents/cloud/protocol.ts).
metadata:
  version: 1.0.0
  updated: 2026-08-24
  origin: authored
  source: harvested from ~/.claude/projects/-home-dev-projects-personal-pitchbox/memory/cloud-repos-dev-layout.md
  status: active
---

Operational detail for `cloud/runner` (`@pitchbox/runner-service`) and `cloud/adapter`
(`@pitchbox/cloud-adapter`), the two private git submodules of this umbrella. See
`AGENTS.md`'s "Cloud runner & repo layout" for the submodule/gitlink basics this
extends.

**Verify before you branch.** A submodule frequently sits in detached HEAD at the
recorded gitlink rather than on `main`. Before starting work: `git -C cloud/<x>
checkout main`, then confirm `main == origin/main == <the umbrella's gitlink for
cloud/<x>>`. If `main` looks stale, `git -C cloud/<x> reset --hard origin/main`
before branching from it - branching off a stale or detached tip silently loses
the relationship to what's actually deployed.

**Landing a change:** commit inside the submodule -> `git -C cloud/<x> checkout
main && git -C cloud/<x> merge --ff-only <branch>` -> `git -C cloud/<x> push
origin main` -> then in the umbrella, `git add cloud/<x>` (stages only the
gitlink pointer bump) and commit that here. Never `git add cloud/*` content
from the umbrella - only the gitlink moves from the umbrella's side.

**Protocol vendoring.** The OSS wire contract lives at
`shared/src/agents/cloud/protocol.ts` and is kept dependency-free (hand-written
validators, no zod/ajv) specifically so it vendors cleanly:
- `cloud/runner` keeps a **vendored copy** at `src/protocol.generated.ts`,
  regenerated with `cd cloud/runner && pnpm sync:protocol` - this must run from
  inside the umbrella (it copies the umbrella file verbatim).
- `cloud/adapter` does **not** vendor - it imports the umbrella protocol file by
  relative path.
After editing `protocol.ts`, regenerate the runner's copy before committing
either side, or the two drift silently.

**Worktree isolation does not fit a protocol change.** A protocol edit spans the
umbrella (`shared/.../protocol.ts`) and the runner submodule
(`protocol.generated.ts`) at once, and an umbrella `git worktree` does not
cleanly carry a submodule's own working tree. Do this kind of cloud work
sequentially, with one actor in the main tree, committing to each repo
separately (`git -C <repo> ...`) - not via the parallel-worktree pattern used
for the rest of the repo.
