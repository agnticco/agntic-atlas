# Agent Contracts — audit & reconciliation (2026-07-16)

**Source:** an external design spec (`atlas-agent-contracts.md`, authored in a conversation
without codebase access) proposing Atlas be re-drawn as three contract-bounded agents —
**Elicitation → Converger → Executor** — with a *machine-readable SOP* as the first hand-off
and five HITL approval gates.

This document is the **grounded reconciliation**: what the spec gets right, where it diverges
from `main` (with `file:line` evidence from a three-scout audit), and the decided path. It is the
standing contract for the follow-on increments. If code and this doc disagree, fix this doc in the
same commit.

---

## Verdict

**Do not do the wholesale three-agent refactor.** The spec's author could not see the one thing
P12 actually built: the workflow is driven by a machine-**checkable outcome contract proven by
running the workflow** (`outcome.{statement,assertions,examples}` + the self-test oracle,
`src/workflows/outcome-oracle.js`), not by a descriptive SOP a human reads and nods at. A prose SOP
is *weaker* on exactly the axis that makes outcomes predictable. Replacing the contract with an SOP,
or introducing hard internal boundaries the user never sees, is cost and regression risk with no
user-visible upside.

**Instead: keep the contract + oracle, and adopt the spec's three genuinely-missing ideas as
additive enrichments** — a pre-build Plan approval gate, inferred-vs-stated confidence marking, and
richer node descriptions/inputs/outputs.

---

## Current code → three phases (grounded)

| Spec agent | Reality | Boundary |
|---|---|---|
| **Elicitation** | `outcome → process → examples → analyze` inside one 14-node `StateGraph` (`src/converger/elicitation-graph.js`) | No hand-off object, no approval gate before the build |
| **Converger** | Same graph: `generate` (one Opus pass → whole node graph, silent) `→ destinations → decisions → gaps → verify → walkthrough → ratify` | Elicitation + converger are one continuous pass |
| **Executor** | `flow-tester.js` (engine) + `workflow-scheduler.js` (trigger dispatch) + `workflow-store` telemetry | **Already matches the spec** — schedule/email/event/manual dispatch, P9 time-saved wired into the run path (`workflow-scheduler.js:472`), draft/active/paused states, user-only go-live |

### HITL checkpoints, as implemented
1. **Approve machine-readable SOP (pre-build)** — **ABSENT.**
2. **Approve each node** — effectively present but repositioned: `walkthrough` (`elicitation-graph.js:2167`) is step-by-step node approval of the *final settled* graph. Mid-build node approval was deliberately removed (2026-07-16 restructure) because the tail (`destinations`/`gaps`/`verify`) changed nodes underneath the user — **the spec's "approve nodes during converger review" is a known bug, not a feature.**
3. **Approve assembled draft** — present (`walkthrough` + `ratify`).
4. **Confirm test run** — weak: `verify` (`elicitation-graph.js:1992`) dry-runs silently; result surfaces only as a read-only field inside the `ratify` interrupt.
5. **Submit go-live** — present, user-only (`POST /api/builder/workflows` → `status:'active'`).

### Gap table

**Elicitation SOP fields** — mostly absent. `workflow_name`/`description`/`trigger` present;
`expected_outputs`/`error_cases`/`clarification_gaps` partial (as the contract + live gap scorer);
`happy_path`, `decision_branches`, `actors`, `required_inputs`, `constraints`,
`connector_roster (pruned)`, `confidence_scores` — **zero hits across `src/`.** The build reasons
over the tenant's *entire* connected catalog on every call (no per-workflow pruning;
`src/api/builder.js:1264-1404`).

**Node object** — carries `{id,type,label,config}` (+ sibling `on_error`/`idempotency`).
`connector_action` is implicit (`config.action`/`config.channel`); per-instance human `description`
**absent** (only a short `label` + a generic type-level blurb); `inputs` **100% implicit**
(`{{template}}` refs + ancestor auto-aggregation, `node-types/_node-input.js`); `outputs`
**absent** (no output schema — already a named P12-F residual).

**Capabilities-as-data** — consumption is genuinely dynamic (`capability-registry.js`), but
registration is a hand-maintained `register*` list and there are hardcoded per-connector seams in
`prompts.js` (output-format by connector id; Slack/Gmail special-casing) and `elicitation-graph.js`
(F-era destination/example logic). **This is the P13-0 seam already on the roadmap — fold in, don't
duplicate.**

**SOP artifacts** — only the human-readable, post-publish SOP exists (`sop-generator.js`, derived
from the live spec). No machine-readable SOP drives the build.

---

## Decided hand-off schemas

### A) The Plan object (new pre-build gate)
A human-legible **projection** of the existing contract + the backward-chained process — NOT a
replacement for `outcome`. Rendered for approval between `examples`/`analyze` and `generate`.

```
Plan {
  outcome: { statement, assertions[], examples[] }    // the existing machine contract, unchanged
  trigger: { type, config, confidence }               // 'stated' | 'inferred'
  happy_path: [ { text, source_capability?, confidence } ]   // derived from the `process` node
  branches:  [ { when, then, confidence } ]           // from induced decisions / routing
  error_handling: [ { case, response, confidence } ]  // from NO_ERROR_PATH / escalation policy
  connector_roster: [ capabilityId ]                  // pruned to this workflow
  open_questions: [ gap ]                             // blocking gaps still unanswered
}
```
**Skippable with a safe default** — Enter accepts as-is, preserving the zero-typing path
(P12-G). Only `inferred` items draw the eye. Approving the plan hands `generate` an explicit
skeleton to fill (fewer regenerations, same-intent→same-structure — a predictability lever, not
just UX). Design mockup: `tmp-g-verify/plan-gate-mockup.html` (approved design language: amber
accents, the `outcome_check` card idiom at `public/index.html:520`).

### B) Enriched node object (additive)
```
Node {
  id, type, label, config,          // unchanged
  description: string,              // NEW — per-instance plain language ("Summarize the billing email for #sales")
  inputs:  [ { from: 'nodeId.field', as: name } ],   // NEW — make implicit template refs explicit
  outputs: [ { field, type } ],     // NEW — the missing output schema (also unblocks P13)
}
```

---

## The grounding pass (decided 2026-07-16, operator) — elicitation must USE the tools

The audit found elicitation *transcribes* the catalog: it reasons over the entire connected
universe on every call, never reads the knowledge base, and resolves concrete resources (channels,
bases, columns) only AFTER the build in the `destinations` tail. The operator's direction: make
elicitation **tool-using**, and hand the converger a **pruned, grounded roster** instead of the
whole universe.

**Precise seam:** the converger at build time wants *capability context*, not tokens — "token
injection" (`injectTenantTokens`/`CONNECTOR_INJECTORS`) stays a RUNTIME concern. What we enrich is
the roster. Elicitation probes tools using the tenant's tokens via the existing
`invokeCapability` (already wired in `builder.js`), plus the per-tenant RAG store.

**New node `ground`**, between `examples` and the Plan gate:
```
outcome → process → examples → GROUND → plan (approve) → generate → …
```
It does four things and emits the result into BOTH the Plan card and the generate prompt:
1. **Prune** the catalog to a *relevant roster* (LLM ranks). **Guard: rank/highlight, NEVER
   hard-remove** — the converger still receives the full catalog as fallback, or a slightly-wrong
   prune makes a needed connector unreachable (the silent-failure class this project keeps hitting).
2. **Probe connectors** — resolve the live resources the workflow will touch (real #channels,
   Airtable bases+columns, Sheets tabs). This is what `destinations` does today, moved EARLIER
   (step 2 below folds `destinations` into here — so the converger builds against real ids, not
   hallucinated ones corrected in the tail; also kills regeneration variance).
3. **RAG the knowledge base** — one query keyed on intent+outcome against the tenant's uploaded
   knowledge (per-tenant isolated). **Relevance-gated** (score threshold; no match → silent). Two
   jobs: (a) surface to the user as an `I found` item WITH the source file cited; (b) inject the
   matched chunks into the generate prompt so the build reflects company specifics. Advisory, never
   authoritative — the user can reject it in the Plan.
   **Bidirectional (operator, 2026-07-16): when a JUDGMENT dimension has no knowledge to ground it,
   suggest an upload.** Each `I inferred` item that represents a policy/criteria/tone judgment (NOT
   a mechanical inference) with no knowledge match becomes an optional, specific prompt: "upload
   your <named artifact> → so <concrete benefit>." Guards: **don't nag** — only genuine judgment
   dimensions, cap to the single highest-value suggestion, name the artifact + why, and keep it
   fully optional (skip → build with the safe default; zero-typing survives). Upload → re-ground →
   the `I inferred` becomes an `I found`.
4. **Inbox examples** — already done (`fetchRealExamples`); keep.

**⚠️ THE CONFIDENCE MARKING DESCRIBED BELOW WAS REMOVED ON 2026-07-27 (operator's call).**
The section is kept as the record of what was built and why, because the reasoning outlived
the feature — but **none of it is in the code any more**. `plan-provenance.js`,
`said-words.js`, the `you said / I found / I inferred` chips, the word-level highlighting,
the legend, the `typedTurns` channel and the per-line `confidence` field are all gone. The
plan card renders plain text. Anything in this file that reads as a live description of the
marks is history. What survives in code, and must: the plan **states** a missing Slack
destination truthfully and does **not** pre-announce that Atlas will create it — that is the
create-or-pick step's decision (pinned by `tests/converger/plan-grounding-prompt.test.js` and
`tests/converger/plan-gate.test.js`). See ENGINEERING-LOG.md for the lessons that were kept.

*(Historical, as built 2026-07-26.)* **Confidence vocabulary** (extended the two-value chip):
`you said` (stated cold) · `I found` (resolved live from a tool — connector or knowledge,
cited) · `I inferred` (a guess to check).

*(Historical.)* **The vocabulary was a CLOSED domain, and it failed to the weaker claim**
(fixed 2026-07-26). `stated | found | inferred` is written by a model, so anything else can
arrive — missing, empty, `null`, a typo, or an invented phrase. Every one of those rendered
as **`I inferred`**. Only the literal `stated` could produce `you said`, because that mark is
a claim *about the user* and Atlas may only make it when the user actually said the thing.
The coercion ran **twice on purpose** — server-side where the plan is assembled, and again in
the browser — so a client that never ran still could not be handed an unlabelled item.

## Increments (revised sequence)

1. **Plan gate + confidence marking + upload nudge** — ✅ BUILT & verified headed (commits
   `cfd6129`, `bc0a347`). `plan` graph node projects the contract into a plain-language,
   confidence-tagged plan (`you said / I found / I inferred`) shown once before `generate`;
   approved plan threads into the generate prompt as a STRUCTURE skeleton (not literal node
   instructions — `bc0a347` fixed a freeform-node degradation). Upload nudge fires for an
   ungrounded judgment. Skippable; fail-safe; fires exactly once. Knowledge RAG (already fed to
   the build) now also surfaces in the plan as `I found` with source.
2. **Grounding pass** — the plan grounds its DELIVERY destinations against live connectors.
   - ✅ BUILT & verified headed: **Slack channel existence** (`groundPlan` in `elicitation-graph.js`
     → `groundingBlock` in `prompts.js`). A named channel the tenant HAS → tagged `I found` (green,
     "existing #x"). Returns null (no claim) when there's no live list. Verified: `#agntic-x-slack`
     (exists) → `I found`; `#support`/`#sales` (absent) → not `found` (no false "found").
     **CORRECTED 2026-07-26 — a channel the tenant does NOT have is `I inferred`, and the plan
     does not say Atlas will create it.** It used to be told to stay `you said` *and* to state
     that Atlas would create the channel; a tester saw exactly that line ("Atlas will create the
     #ops channel", marked YOU SAID) for a channel they had only NAMED, and the build then skipped
     the work because the plan read as settled. Naming a channel is not saying what should happen
     when it doesn't exist. Atlas already asks that properly after the build — the create-or-pick
     conversation for `RESOURCE_NOT_FOUND` (`gap-scorer.js` → the `gaps` node) — so the plan
     describes the situation as its own inference and leaves the decision where it is asked.
   - ✅ BUILT & verified headed: **Airtable schema grounding** (`groundPlan` extended). A
     `record_exists → airtable:<Table>` assertion is resolved against `capabilities.airtableSchema`
     (live base/table/field metadata fetched at session start), so the plan names the REAL base +
     table + columns as `I found` BEFORE the build — the build then writes real field names, not
     hallucinated ones. Verified: "Agntic CRM / Sheet1" resolved with its real columns (Name,
     Email, …) and the writes mapped to them. Null-safe (no schema → no claim). The post-generate
     `destinations` node remains as the authoritative field-mapping safety net.
3. **Node `description` enrichment** — ✅ BUILT & verified headed. `generate` now emits a per-node
   `description` (one plain, INSTANCE-specific sentence naming the real destination/fields), and
   `_nodeDetail` prefers it over the generic type blurb in the walkthrough review + DAG. Validator
   accepts the node-level key; falls back to type text for v1/older specs. Verified: a Slack summary
   build produced "Posts the AI-generated email summary … to the #agntic-x-slack channel". **`inputs`
   / `outputs` schemas deferred** — not consumed until P13, so not added yet (avoids declaring
   fields nothing reads).
4. **Hardcoded per-connector seam cleanup** — into **P13-0**, where it already lives.

## The self-test looping fix (operator, 2026-07-16) — the big consistency win
The operator: "nearly every build ends with the converger saying it rebuilt it a few times."
**Ground truth (Run test on the exact spec): the workflows PASS 3/3 — they are correct.** The
give-up was fully spurious: a dry-run summarize is non-deterministic and, on a wordy/boilerplate
email, sometimes misjudges its (present) input and emits the "required data not found" sentinel.
The oracle reported that as a failure, and the verify loop **regenerated the whole spec** to "fix"
it — futile (the new spec has the same guard and flakes the same way) and expensive (an Opus
rebuild each round). That is the loop.

Fix — distinguish a CONTENT FLAKE from a STRUCTURAL failure and only rebuild on the latter:
- `outcome-oracle.js` exposes `contentError` (the run's only defect is the sentinel — the delivery
  STRUCTURALLY happened).
- `verify` retries a failed sample up to 3 attempts (cheap dry-runs absorb flakes). A failure that
  is content-flake-only → the workflow is built and wired correctly (the validator guaranteed the
  wiring, the real Run test passes it), so it is **presented plainly** ("built and every step is
  wired correctly — give it a test run"), **never rebuilt, never a give-up**. Only a STRUCTURAL
  failure (a promised delivery genuinely didn't happen, or the run errored) regenerates, bounded as
  before. Pinned by `verify-loop.test.js` (a content flake must not regenerate or give up).

## Redundant-gap suppression (operator, 2026-07-16)
The error-handling gap-review ("what if a step fails? Keep the safe defaults") surfaced mid-build on
EVERY build, always the same, always defaulting to escalate — and the **Plan gate now already shows
it** ("If something breaks → …", tagged inferred, changeable there). So the mid-build interrupt is
redundant with the plan. It is suppressed: the NO_ERROR_PATH default is auto-applied silently (the
same escalate policy `escalation.js` materializes at publish), so the build no longer stops to ask a
question the plan already answered.

## What must NOT change
- The outcome contract + self-test oracle stays the machine artifact and the gate.
- No mid-build node approval (the tail churns underneath it).
- Every gate stays skippable with a safe default (zero-typing path).
