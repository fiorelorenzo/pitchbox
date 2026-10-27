---
name: pitchbox-cloud-submodules
description: Use when committing or branching inside the cloud/runner or cloud/adapter private submodules. Both are retired (#420): nothing in the umbrella builds, deploys, or imports from either anymore, and the OSS protocol contract they used to share (shared/src/agents/cloud/protocol.ts) is gone.
metadata:
  version: 1.1.0
  updated: 2026-09-08
  origin: authored
  source: harvested from ~/.claude/projects/-home-dev-projects-personal-pitchbox/memory/cloud-repos-dev-layout.md; retirement note added while landing #420 (both submodules unwired from the umbrella)
  status: active
---

Operational detail for `cloud/runner` (`@pitchbox/runner-service`) and `cloud/adapter`
(`@pitchbox/cloud-adapter`), the two private git submodules of this umbrella. Both
are retired as of #420: the cloud runner is now the in-process SDK runner
(`shared/src/agents/sdk/runner.ts`), which needs neither. Nothing in the umbrella
references either submodule's content anymore - this skill only still applies if
you are doing archaeology inside one of them, or reviving one for a new purpose.
See `AGENTS.md`'s "Cloud runner & repo layout" for the submodule/gitlink basics
this extends.

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

**Protocol vendoring is history, not a live workflow.** The OSS wire contract used
to live at `shared/src/agents/cloud/protocol.ts`; #420 deleted it along with every
umbrella-side caller, since the WS session/MCP-relay protocol it described has no
new-shape equivalent (the SDK runner is in-process, nothing to relay). `cloud/runner`
still carries its old vendored copy at `src/protocol.generated.ts` and `cloud/adapter`
still imports it by relative path, but both are now stale copies inside retired,
unreferenced submodules - there is nothing left in the umbrella to regenerate
against. Reviving the runner service would mean re-authoring a contract, not
resyncing this one.

**Worktree isolation does not fit submodule work in general.** An umbrella
`git worktree` does not cleanly carry a submodule's own working tree (the
submodule needs its own `git submodule update --init` per worktree, and a
gitlink bump made in one worktree is invisible to the others until they pull
`main`). Do cloud work sequentially, with one actor in the main tree,
committing to each repo separately (`git -C <repo> ...`) - not via the
parallel-worktree pattern used for the rest of the repo.
