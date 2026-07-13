# Brief — P12 Increment A: validator hardening + node-library re-cut

**Grounded against `main` @ `3ec56ee` on 2026-07-13.** Line numbers below are
**non-authoritative provenance** — re-ground against the exported symbol before you act.
The **invariant + the acceptance test** are the contract, not the coordinates. If you find the
premise doesn't match current code, **say so and stop** — refusing to fix a non-bug is correct
discipline, not obstruction.

---

## Your role

You are the **Builder** for **one** deliverable: **P12, Increment A**. Nothing else.

Read `CLAUDE.md` first — it is the constitution, and it overrides anything here that conflicts.

**Do not start Increment B.** Do not "while I'm in here" any other increment. One deliverable
per session, ending at a gate (CLAUDE.md, Working rules).

---

## Orient (first command)

```bash
bash scripts/gate.sh 12
```

This is a **progressive, fail-closed gate**. It runs the regression block, then increments A→G
in order, and **stops at the first unbuilt one**. Today it fails at Increment A and tells you
exactly why. It is the definition of done, executable. Run it now, and run it again as you go.

Then read, in this order:

1. `CLAUDE.md` — closed decisions, the **don't-touch salvage list**, gate rules.
2. `docs/architecture/converger-v2.md` — **§1** (current contracts, read out of the code),
   **§2** (target), **§10 → Increment A** (your scope), **§11** (what must not break).
3. `scripts/gates/p12.sh` — the checks you must satisfy.
4. `docs/COMMIT_CONVENTION.md` — the commit-msg hook enforces it. **Header ≤72 chars.**

You do **not** need `bpmn-dmn-foundations.md` for this increment. It's theory for C and E.

---

## The work

### 1. `UNKNOWN_CONFIG_KEY` — the highest-leverage check in the phase

**Invariant:** a node's `config` keys must be a subset of that node type's declared
`configSchema`. An unknown key is a **validation error**, not a shrug.

**Why this matters more than it looks.** A real converger output carried
`"model": "claude-opus-4-5"` on an LLM node. That model does not exist, the key is not in the
schema, and **nothing rejected it** — the executor silently ignored the key and ran on the
default model. That is defect #3 in the build spec: the converger can hallucinate a config
field and the system will cheerfully run it. This check turns a silent production failure into
a build-time error.

**Where:** `src/workflows/workflow-validator.js` (`validate()` returns
`{ok, errors, warnings, issues}` — verify that shape yourself before relying on it). Node types
and their `configSchema` live in `src/workflows/node-types/`.

### 2. `llm.mode` — collapse the node library

`src/workflows/node-types/llm.js` gains `mode: summarize | extract | rewrite | classify |
freeform`. Then **delete** these node types and remove them from the registry
(`node-types/index.js`):

| Delete | Why |
|---|---|
| `summarize.js`, `extract.js`, `rewrite.js`, `daily-digest.js` | They are `llm.js` with a different prompt. Collapse into `mode`. |
| `tool.js`, `mcp-tool.js`, `fetch.js` | **Not runnable in this build.** There is no `ToolRegistry` (no `src/tools/`, never instantiated) and `FlowTester` is built without `tools`, so these throw at runtime. They are dead weight that the converger can still emit. (CLAUDE.md, Known gotchas.) |

**Ship a v1 compat shim** mapping the old `type` → `llm` + `mode`, so existing specs keep
running. This is not optional — see the invariant below.

---

## Acceptance (this is the contract)

- [ ] A spec with `"model": "claude-opus-4-5"` on an LLM node is **rejected** with
      `UNKNOWN_CONFIG_KEY`. Write the failing case as a test *first* and watch it fail.
- [ ] `bash scripts/gate.sh 12` gets **past Increment A** and stops at Increment B. (It will
      still exit non-zero — that is correct. B is not built. Success here means the *reason*
      it fails has moved from A to B.)
- [ ] **All 13 local workflows still validate** and **the 1 live prod workflow's spec still
      validates.** Prod runs a v1 spec; if your change breaks it, you have broken production.
- [ ] P2, P3 and the E2E suite are green — the regression block at the top of `gate.sh 12`
      runs these for you.

**Running the E2E suite:** it **self-skips the converger test without `ANTHROPIC_API_KEY`** and
still reports a cheerful "6 pass / 1 skip" — and the skipped test is the converger. Run it with
a key (`node --env-file=.env --test tests/e2e/full-journey.test.js`, expect **7/7**) or you are
passing a gate you have not proven. This bit us on P11.

---

## Invariants — do not break these (converger-v2.md §11)

1. **P3 stays green.** The converger must still reproduce the frozen canonical spec
   (`docs/specs/canonical-ups-slack.json`). **Never regenerate that file.** Equivalence is
   *structural + runnable*, never byte-for-byte — the converger is non-deterministic.
2. **A v1 spec executes byte-identically.** This is what the compat shim is for. Prod has one
   live workflow and it is a v1 spec.
3. Cross-tenant isolation holds. Tier caps hold. (Both in the gate's regression block.)

---

## Hard rules

- **Evidence-gating.** Do not claim anything is missing, broken, or dead without a `file:line`
  or the exact command that returned nothing. Negative claims need **proof of absence**, not
  absence of proof.
- **Never `--no-verify`.** A `PreToolUse` hook blocks it. **Never weaken a gate or a check to
  force a pass.** If a check is wrong, fix the check and record why in `CLAUDE.md`, in the same
  commit.
- **Never force-push.**
- **Do not touch the salvage** (agent core, execution engine, MCP runtime, auth/vault, RAG)
  beyond what this brief authorises. If you must, record it in `CLAUDE.md`'s "Recorded salvage
  edits" list in the same commit. The validator and node-types **are** engine code — your edits
  here are authorised, but they belong in that list.
- **No `Co-Authored-By` trailer and no "Generated with Claude Code" in commits or PR bodies.**
- **A fix is not verified until the process under test was restarted after the fix landed on
  disk.** The dev server does not auto-reload. Check the process start time against the file
  mtime before you trust any result.

---

## Process

1. `git checkout main && git pull` — **branch from `main`**, never from an unmerged PR.
2. `git checkout -b feat/p12-increment-a`
3. Build. Run `bash scripts/gate.sh 12` as you go.
4. Commit per `docs/COMMIT_CONVENTION.md` with a `Phase: 12` trailer.
   **Do NOT add a `Gate:` trailer** — Increment A does not close the phase, and the pre-push
   hook will (correctly) block a `Gate: P12` commit until *every* increment is done.
5. Open a PR. A **fresh verifier that did not write the code** closes gates — not you.

## Out of scope — do not do these

- **Do not deploy.** Prod is live at atlas.agntic.co. The operator deploys, only when they ask.
  Pushing `main` does **not** deploy; nothing you do here should reach prod this session.
- Do not start Increment B (`branch` / `on_error` / `idempotency`) or any later increment.
- Do not touch billing, Stripe, tenancy, or the connectors.
- Do not edit `docs/specs/canonical-ups-slack.json`.

---

## If you get stuck

If the brief's premise doesn't match the code you find, **believe the code**. Report the
mismatch with evidence and stop. Do not invent work to satisfy a stale instruction.
