# Atlas

A conversational AI workflow builder by **Agntic**. Users build workflows by
talking — the system proposes one step, the user confirms, and it measures the
gap to a complete spec, repeating until the workflow is finalized. Finished
workflows compile to a JSON spec the execution engine runs and makes observable.

Atlas is built on a real, running workflow execution engine (topological DAG
executor, per-user MCP connector runtime, encrypted credential vault, revocable
auth). The build ahead is the **elicitation engine** — the conversational
converger — and the surfaces around it.

## Build orientation

- **The plan:** [`docs/agntic-ops-gap-and-build-plan.md`](docs/agntic-ops-gap-and-build-plan.md) — gap map + sequenced Phase 0–7 build plan.
- **Build constitution:** [`CLAUDE.md`](CLAUDE.md) — closed decisions, the don't-touch salvage list, the frozen-spec convention. Read first, every session.
- **Commit convention:** [`docs/COMMIT_CONVENTION.md`](docs/COMMIT_CONVENTION.md) — Conventional Commits + phase/gate tags, enforced by a `commit-msg` hook.

## Repo setup

This repo enforces its commit pattern with a local hook. After cloning, point
git at the tracked hooks directory:

```bash
git config core.hooksPath .githooks
git config commit.template .gitmessage
```

(These are set automatically in the repo where it was initialized.)
