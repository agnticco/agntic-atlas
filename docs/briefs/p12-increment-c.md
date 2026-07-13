# Brief — P12 Increment C: converger v2 core + outcome/gap UI (THE MOAT)

**Grounded against `main` @ `96c2e2d` on 2026-07-13** (B merged at `907471d`).
Line numbers below are **non-authoritative provenance** — re-ground against the exported symbol
before you act. The **invariant + the acceptance test** are the contract, not the coordinates. If
the premise doesn't match current code, **say so and stop** — refusing to fix a non-bug is correct
discipline, not obstruction.

---

## Your role

You are the **Builder** for **one** deliverable: **P12, Increment C**. Nothing else.

Read `CLAUDE.md` first — it is the constitution and overrides anything here that conflicts.

**Start a fresh session for this.** Do not carry another increment's context in. C is built by an
agent that rehydrates from the *documents*, not from scrollback — that is the only reason fresh
sessions work (CLAUDE.md, "This document is the handoff"). B took nine verification rounds partly
because context saturation makes an agent defend instead of re-ground.

---

## Orient (first command)

```bash
bash scripts/gate.sh 12
```

Progressive, fail-closed. It runs the regression block, A, and B (all green), then **stops at C**
and tells you the first missing thing. It is the definition of done, executable. Run it as you go.
**Note: the gate is now slow** — B added two mutation harnesses (`mutation-guard.mjs` +
`mutation-sweep.mjs`) that run inside it. Allow 15–20 min for a full pass.

Then read, in this order:
1. `CLAUDE.md` — closed decisions, the don't-touch salvage list, and especially:
   - the **"The verification system had an architectural flaw. Three, actually."** section — the
     apparatus you inherit and must uphold;
   - the P12 increment-A and -B "Recorded salvage edits" entries — what already changed and why.
2. `docs/architecture/converger-v2.md` — **§1** (current contracts, read out of `main`), **§2.2**
   (spec v2), **§2.4/§2.5** (new proposal vocab + interrupt types), **§3** (your converger delta),
   **§5** (validator codes), **§6** (the UI — load-bearing, not trim), **§10 → Increment C**,
   **§11** (invariants). Also `bpmn-dmn-foundations.md` §6/§7 — the gap-analysis theory C needs.
3. `scripts/gates/p12.sh` — the C block is your checklist.

---

## The work (converger-v2 §3, §5, §6, §10-C)

### 1. `gap-scorer.js` — the rewrite. This is the heart.

```
BEFORE: scoreGap(draft) → { needsTrigger, needsProcessing, needsDelivery, needsEdges, needsName, complete }
AFTER:  scoreGap(spec, { capabilities }) → { gaps: [ {id, class, nodeId, message, resolution, decidable} ], complete }
```
Three gap **classes**:
- **outcome** — an `outcome.assertions[]` with no node that satisfies it. *(kills defect #1, the
  "Slack AND email" silent drop.)*
- **coverage** — a `decision` table with uncovered enumerable input combinations, a `UNIQUE`
  hit-policy table with overlapping rules, or a `branch` with no `*`. *(kills defect #5.)*
- **contract** — required config unset; unknown config key; write node with no `idempotency`; node
  with no `on_error`. *(kills defect #3.)*

`resolution` defaults to **`'escalated'`** (a gap the user didn't answer escalates to a human —
this is what makes "Accept all defaults" honest). `complete` = every gap answered **or** escalated.

**Gap analysis is the hyper-rectangle method** (Calvanese et al., `bpmn-dmn-foundations.md`):
enumerate the cross-product of enumerable input domains, a rule is a box, report uncovered regions.
**Decidable only over enums / bounded ints / booleans.** Anything with an infinite domain →
`decidable: false`, and the UI must say so and require a catch-all instead. **Never imply a
completeness proof you cannot make** — that is the whole moat; a false proof is worse than none.

### 2. `workflow-validator.js` — two codes (the moat lives here)

- **`UNSATISFIED_ASSERTION`** — every `outcome.assertions[]` must map to ≥1 node that satisfies it.
  This is what makes defect #1 (a requested delivery silently dropped) **unpublishable**.
- **`LLM_INPUT_NOT_ENUM`** (§11.7 — **THE MOAT, never weaken it**) — a `decision` input with
  `evaluator: 'llm'` **must** be `type: 'enum'` with a closed `values` list. A free-text LLM
  decision input makes gap analysis undecidable, which deletes the completeness proof, which is
  the product. See the spec-v2 example in §2.2 and the rule box under it.

### 3. `elicitation-graph.js` — five new graph nodes

`outcome` · `examples` · `decisions` · `process` · `gaps` (see §3 for each). Keep the v1
`analyze`/`clarify`/`propose` path alive until C is green (§9 has the cutover). `spec-assembler.js`
emits `version: 2` with `outcome{statement, assertions, examples}`; `prompts.js` gains
`buildOutcomePrompt/buildExamplesPrompt/buildDecisionPrompt/buildProcessPrompt`, and **the system
prompt must enumerate the closed node vocabulary AND the template grammar** (`{{prev}}`,
`{{<id>.output}}`, `{{date}}`…) — defect #3 existed because it didn't. Store **provenance** in
`interaction-store.js` (which turn/quote produced each assertion/rule; which gaps escalated by
default) — in the store, **not** the spec; it feeds the SOP.

### 4. The UI (§6 — this ships WITH C, it is not a later phase)

The shared `choices[]` primitive · outcome cards (`outcome_check`) · the pinned outcome card · the
gap list (`gap_review`) with **escalate pre-selected** and **Accept all defaults**. §6 elicits
strictly more than v1; without the UI that becomes a 40-question interrogation and activation dies.

---

## Acceptance (this is the contract — §10-C)

- [ ] The **"Slack AND email"** case (defect #1) **cannot publish** — fails `UNSATISFIED_ASSERTION`.
- [ ] A **2-node workflow ratifies without inventing an LLM node** (defect #4).
- [ ] The converger asks **≥1 exception question** (defect #5).
- [ ] **A user can publish a gap-free workflow by clicking only defaults — zero free-text turns.**
- [ ] `bash scripts/gate.sh 12` gets **past C and stops at D.** (Still exits non-zero — correct.
      Success = the reason it fails moves from C to D.) The C checks:
  - `tests/converger/gap-oracle.test.js` exists + passes — `scoreGap()` over crafted specs:
    unsatisfied assertion · table gap · UNIQUE overlap · non-exhaustive branch · unknown config key.
  - `UNSATISFIED_ASSERTION` and `LLM_INPUT_NOT_ENUM` in the validator.
  - `scripts/checks/converger-adversarial.mjs` exists + reports `CONVERGER-ADVERSARIAL-PASS`:
    contradictory outcomes; unstateable outcomes; an outcome needing an absent connector — **it
    must NEVER silently drop an assertion.**
- [ ] **Regression block stays green** — and note it now includes P3, E2E (**7/7 with
      `ANTHROPIC_API_KEY`** — it self-skips the converger test without one), cross-tenant, tier
      caps, **and B's mutation-guard (25/25) + mutation-sweep (floor 0.72).**

---

## The verification apparatus you INHERIT (and must uphold)

B was hardened after nine rounds. C is held to the same bar — do not regress it:

- **Every guard must be mutation-tested.** A green suite is evidence of nothing until you have
  watched it go red. Re-introduce each bug; confirm a test fails; restore.
- **Never quote a mutation score in a doc** — it is a claim about tests you didn't write. State the
  rule; let the verifier derive the number.
- **Spawn the `test-adversary` agent** (`.claude/agents/test-adversary.md`) **after you build, and
  BEFORE the verifier.** It writes the pinning tests you can't — the Builder grading his own tests
  is the tautology that let ~21 defects hide behind green. It may write `tests/`+`scripts/checks/`,
  never `src/`.
- **Then the fresh `verifier`** for the readiness verdict. It did not write the code.
- **Widen `mutation-sweep.mjs` `TARGETS`** to include `workflow-validator.js` (and any converger
  file C makes load-bearing) — the round-9 verifier flagged that those surfaces are graded only by
  the curated guard today. Watch the floor when you do (new files surface equivalent-mutant
  survivors; the floor is a **ratchet** — raise it when the rate rises, never lower it to pass).

---

## Invariants — do not break these (converger-v2 §11)

1. **P3 stays green** — the converger still reproduces the frozen `docs/specs/canonical-ups-slack.json`.
   **Never regenerate that file.** Equivalence is structural + runnable, never byte-for-byte.
2. **§11.2** — a v1 spec (no control flow) executes byte-identically. B proved it; don't undo it.
3. **§11.7 `LLM_INPUT_NOT_ENUM`** — the moat. Non-negotiable.
4. Cross-tenant isolation, tier caps, the mutation harnesses — all stay green.
5. **No spec publishes with an unresolved gap that isn't explicitly escalated.**

---

## Hard rules

- **Evidence-gating.** No "missing/broken/dead" claim without a `file:line` or the exact command
  that returned nothing.
- **Never weaken a gate, a check, or a test to force a pass, and never `--no-verify`.** If a check
  is wrong, fix the check and record why in `CLAUDE.md`, same commit.
- **Keep the docs true in the same commit as the code.** D rehydrates from `CLAUDE.md` +
  `converger-v2.md`. If your work falsifies §1/§3/§5/§6, fix the doc — that is a deliverable.
- No `Co-Authored-By` / "Generated with Claude Code". No `Gate:` trailer (C doesn't close the
  phase). `Phase: 12` trailer. Branch `feat/p12-increment-c` **from `main`**, never from an
  unmerged PR.
- **Do not deploy.** Do not start D (`human` channels / Approvals inbox / forgery-proof tokens).
  Do not touch billing, Stripe, tenancy, or the connectors beyond what C needs.

## Process

1. `git checkout main && git pull` → `git checkout -b feat/p12-increment-c`.
2. Build. Run `bash scripts/gate.sh 12` as you go.
3. Commit per `docs/COMMIT_CONVENTION.md` (`Phase: 12`, header ≤72 chars, no `Gate:` trailer).
4. **`test-adversary` → then `verifier`.** Open a PR. Merge only on an independent PASS.

## If the brief's premise doesn't match the code

Believe the code. Report the mismatch with evidence and stop. Do not invent work to satisfy a
stale instruction.
