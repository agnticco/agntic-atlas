# Converger v2 — build specification

**Status:** ready to implement · **Rev 2** (2026-07-13) · **Read first:**
[`bpmn-dmn-foundations.md`](./bpmn-dmn-foundations.md) — it contains the theory this
document assumes, and it *revised* rev 1 of this file in eight places.

---

## 0. How to use this document

This is written for a coding agent picking up one increment cold.

- **§1 is the current state** — the real contracts as they exist in `main` today. Do not
  re-derive them; they were read out of the code on 2026-07-13.
- **§2 is the target state** — the same contracts, after v2.
- **§3–§9 are the deltas**, file by file, with before/after signatures.
  **§6 (the elicitation UI) and §7 (the human approval gate) are load-bearing, not trim.** v2
  elicits strictly more than v1; without §6 that becomes a 40-question interrogation, and
  without §7 the "accept all defaults" escape hatch in §6 would be a lie. Do not treat either
  as a phase to be tacked on at the end — they are folded through the increments deliberately.
- **§10 sequences the work** into increments. Each has explicit **acceptance criteria** and a
  gate. Do one increment per session, end at its gate.
- **§11 is the list of things that must not break.** Check it before you open a PR.

**Anchors are exported symbol names, not line numbers.** Per CLAUDE.md, line numbers in a brief
are non-authoritative provenance — re-ground against the symbol.

### This document is the handoff. Keep it true.

Each increment is built by a **fresh session with no memory of the last one**. That is
deliberate: an agent carrying 200k tokens of its own prior reasoning stops re-grounding and
starts defending decisions it made three increments ago. Fresh sessions work *only* because
**this document carries the state instead of the agent**.

Which imposes one obligation on you:

> **If your work contradicts this document, fix this document in the same commit as the code.**

Not a follow-up. Not a TODO. The same commit. §1's contracts were read out of `main` on
2026-07-13 — if you find they have drifted, **the code is right and this file is wrong**, and
correcting it is part of your deliverable.

A spec that disagrees with `main` is worse than no spec: the next session rehydrates from it,
trusts it because it looks authoritative, and builds on a lie. That costs a full round, every
time. **The document going stale is the single most likely way this build fails.**

---

## 1. CURRENT STATE (as of `main`, 2026-07-13)

### 1.1 Converger — `src/converger/`

| File | Exports | Contract |
|---|---|---|
| `index.js` | `createConverger({ llm, capabilities, checkpointerDir, interactionStore, tenantId, userId })` → **`{ run(threadId, intent), resume(threadId, value), abandon(threadId), getState(threadId) }`**<br>`runHeadless({ intent, capabilities, llm, checkpointerDir })` | The only entry points the app uses. **Keep both signatures stable.** |
| `elicitation-graph.js` | `buildElicitationGraph({ llm, checkpointerDir })` | A compiled `StateGraph`. Nodes: **`analyze` · `clarify` · `propose` · `ratify`**. Edges: `analyze →(cond) clarify\|propose\|ratify`; `clarify → analyze`; `propose → analyze`; `ratify →(cond) done`. |
| `gap-scorer.js` | `scoreGap(draft)` → `{ needsTrigger, needsProcessing, needsDelivery, needsEdges, needsName, complete }`<br>`gapLabel(gap)` → string | **A hardcoded 5-item checklist.** This is the file v2 exists to replace. |
| `spec-assembler.js` | `applyProposal(draft, proposal, confirmation)` → draft<br>`assembleSpec(draft)` → spec | Applies one atomic edit to the draft. |
| `prompts.js` | `buildSystemPrompt(capabilities)`<br>`buildAnalyzePrompt({ intent, clarifications, capabilities })`<br>`buildProposePrompt({ intent, clarifications, draft, gap, setupResults })`<br>`buildModifyPrompt({ original, modification })` | System prompt is ~7.5k tokens for a fully-connected tenant; it is the cached prefix (v1.3.8). |
| `interaction-store.js` | `startSession`, … | Persists the elicitation transcript. **This is where `provenance` should live.** |

**Elicitation state shape** (`state.*` in the graph):
```
{ intent, capabilities, draft, clarifications, confirmationLog, setup_results, step, phase, spec, _pendingQuestion }
```

**Proposal vocabulary** — `proposal.component` ∈
```
trigger · node · edge · name · description · remove_node · remove_edge · setup_action
```
(see the `switch` in `applyProposal`). This is the complete set of atomic edits the converger
can currently make.

**Interrupt types** (the UI/API contract, consumed in `public/index.html`):
```
clarification · proposal · ratify · done
```

### 1.2 Engine — `src/workflows/`

| File | Contract | Limitation that matters |
|---|---|---|
| `flow-tester.js` | **`async* run(flow, options)`** → async generator of events (`run_started`, step events, …) | **Kahn topological sort, then RUNS EVERY NODE.** No conditionals, no iteration, no pause. |
| `node-type-registry.js` | `register({ type, label, description, icon, family, configSchema[], previewTemplate, run(cfg, ctx, services), validate? })` | The node-type contract. `configSchema` drives the inline editor **and** is the only declared shape of a node's config. |
| `workflow-validator.js` | `validate(def)` → **`{ ok, errors[], warnings[], issues[] }`** (`ok = errors.length === 0`); issue = `{ severity, code, message, nodeId, field, hint }` | Existing codes incl. `MISSING_TRIGGER`, `MISSING_DELIVER`, `UNKNOWN_NODE_TYPE`, `MISSING_CONFIG`, `BAD_TEMPLATE_REF`, `EDGE_BAD_FROM/TO`. |
| `node-types/` | `trigger` `llm` `summarize` `extract` `rewrite` `deliver` `connector-action` `search-web` `daily-digest` · **dead:** `tool` `mcp-tool` `fetch` | `summarize`/`extract`/`rewrite` are **prompt presets, not distinct execution semantics**. |
| `node-types/_node-input.js` | Template resolution | Grammar: **`{{prev}}`, `{{<nodeId>.output}}`, `{{date}}`, `{{time}}`, `{{datetime}}`, `{{year}}`, `{{month}}`, `{{day}}`.** Nothing else. |

**The engine is a dataflow DAG, not a process engine.** It is structurally closer to DMN's
Decision Requirements Graph than to a BPMN process. See `bpmn-dmn-foundations.md` §4.

### 1.3 Spec v1 (what the converger emits today)
```jsonc
{
  "name": "…", "description": "…",
  "triggers": [ { "type": "schedule|email|…", … } ],
  "nodes":    [ { "id", "type", "label", "config": {…} } ],
  "edges":    [ { "from", "to" } ]
}
```
No outcome. No conditions. No decisions. No failure paths.

### 1.4 Known defects this design must kill
Measured 2026-07-13 across 13 workflows built through the real UI.

| # | Defect | Root cause |
|---|---|---|
| 1 | Converger **silently dropped a requested delivery step** (asked for Slack **and** Gmail, confirmed twice; spec had only Slack) | Nothing declares what the finished workflow must produce |
| 2 | ~~`{{today}}` reached Google → 400~~ | **FIXED** (`1601634`) — the run path now validates. Root cause was *the test-run path skipping the validator*, **not** a missing check. |
| 3 | ~~Dead `"model":"claude-opus-4-5"` on LLM nodes~~ | **FIXED (Increment A)** — `UNKNOWN_CONFIG_KEY`. Root cause was *two* things, not one: config keys were never checked against `configSchema`, **and `prompts.js` literally advertised `llm (config: prompt, model)`** — the prompt was *telling* the model to emit a key no schema had. Both are fixed; the converger now emits `llm` + `mode` natively, with no `model` key. |
| 4 | **Cannot tell a 2-node workflow is finished** — invented an LLM node to satisfy the checklist | `scoreGap()` demands a "processing" node |
| 5 | **Zero exception questions**, ever | No shape to interrogate |
| 6 | Airtable unreachable conversationally | No schema/base discovery capability |

---

## 2. TARGET STATE

### 2.1 The elicitation order (REVISED — rev 1 had this backwards)

Per Silver: decisions are the hardest part and come **before** the process; discovery happens
**through examples**, not interrogation.

```
intent
  → OUTCOME     "How would we know this worked?"        → testable assertions
  → EXAMPLES    "Show me 3 real cases: in → expected"   → the SME's rows
  → DECISIONS   induce tables from the examples          → typed, gap-analysed
  → PROCESS     wire the graph around proven decisions   → derived, ~no user turns
  → GAPS        "you haven't told me about these 3"      → default: escalate to human
  → RATIFY
```

Two consequences worth stating loudly:
- **The examples become the acceptance suite.** They are the assertions the test panel checks.
- **The user answers far fewer questions**, because rules are *induced*, not interrogated.

### 2.2 Spec v2

```jsonc
{
  "version": 2,
  "name": "Inbound lead capture",

  "outcome": {                                  // NEW — the contract; the anchor
    "statement": "Every inbound sales email produces a Leads record with Name, Company, Budget and Priority; over $50k also pings #sales-urgent.",
    "assertions": [                             // machine-checkable → drives the test oracle
      { "id": "a1", "kind": "record_exists", "target": "airtable:Leads",
        "fields": ["Name","Company","Budget","Priority"] },
      { "id": "a2", "kind": "message_sent",  "target": "slack:#sales-urgent",
        "when": "priority = 'P1'" }
    ],
    "examples": [                               // NEW — the SME's rows; ALSO the test cases
      { "given": { "subject": "Need 200 seats by Q3", "body": "…budget approx $80k…" },
        "expect": { "Budget": 80000, "Priority": "P1", "slack": true } },
      { "given": { "subject": "quick question about pricing" },
        "expect": { "Priority": "P3", "slack": false } }
    ]
  },

  "triggers": [ { "type": "email", "filter": "…" } ],

  "nodes": [
    { "id": "extract_fields", "type": "llm", "mode": "extract",
      "config": { "fields": ["name","company","budget"] } },

    { "id": "score_priority", "type": "decision",          // NEW — DMN decision table
      "inputs": [
        { "key": "budget", "type": "number" },
        { "key": "tone",   "type": "enum",                 // ⚠️ LLM input MUST be a closed enum
          "values": ["calm","neutral","urgent"],
          "evaluator": "llm",
          "evaluatorPrompt": "Classify the sender's tone." }
      ],
      "output":    { "key": "priority", "type": "enum", "values": ["P1","P2","P3"] },
      "hitPolicy": "FIRST",                                 // U | A | P | F | C
      "rules": [
        { "when": { "budget": ">50000" },       "then": "P1" },
        { "when": { "tone": "urgent" },         "then": "P1" },
        { "when": { "budget": "[10000..50000]" },"then": "P2" },
        { "when": { "budget": "-", "tone": "-" },"then": "P3" }   // catch-all ("-" = irrelevant)
      ] },

    { "id": "route_priority", "type": "branch",             // NEW — routes on an EXISTING value
      "on": "score_priority.output",
      "cases": [
        { "when": "P1", "to": "ping_sales" },
        { "when": "*",  "to": "create_record" }             // catch-all is MANDATORY
      ] },

    { "id": "create_record", "type": "connector-action",
      "config": { "action": "airtable_create_record", "baseId": "…", "table": "Leads",
                  "fields": { "Name": "{{extract_fields.name}}",
                              "Priority": "{{score_priority.output}}" } },
      "idempotency": { "key": "{{extract_fields.email}}", "on_conflict": "update" },  // NEW
      "on_error":    { "retry": 2, "then": "escalate" } },                             // NEW

    { "id": "ping_sales",   "type": "connector-action",
      "config": { "action": "slack_post", "target": "#sales-urgent" } },

    { "id": "human_review", "type": "human",                // NEW — where every gap lands
      "config": { "assignee": "inbox", "prompt": "Budget couldn't be determined — set it?" } }
  ],

  "edges": [ /* … */ ]
}
```

**Rule that keeps the moat (do not violate):** an input with `"evaluator": "llm"` **must** be
`type: "enum"` with a closed `values` list. A free-text LLM input makes gap analysis
undecidable — see `bpmn-dmn-foundations.md` §3.3 and §6. **The validator enforces this
(`LLM_INPUT_NOT_ENUM`).**

> **`assertion.when` is CARRIED but NOT PROVEN (Increment C).** The `"when": "priority = 'P1'"` in
> `a2` above is a **run-time condition**. The outcome oracle proves a node exists that *can* produce
> the effect; it does **not** prove the node runs on exactly the inputs the condition names — that
> needs the `decision` shape (E) and the worked examples as a test suite (G).
>
> Treating a conditional assertion as *satisfied* by an ungated node would be a **false proof**: the
> workflow would pass its own contract while pinging `#sales-urgent` for **every** lead, not just the
> big ones. So C says exactly that, out loud: a conditional assertion raises a non-blocking
> `CONDITIONAL_UNPROVEN` coverage gap — *"the outcome says this happens only when X, but nothing
> checks that yet, so it would happen on every run."* **Never imply a completeness proof you cannot
> make**; a claim nobody checked is worse than one nobody made, because the user stops looking.

### 2.3 Node library — re-cut, not ballooned

| | Today | v2 |
|---|---|---|
| **Work (open axis)** | `connector-action`, `llm`, `summarize`, `extract`, `rewrite`, `search-web`, `deliver`, `daily-digest` | `connector-action` *(unchanged — this is the open axis; **do not touch**)*<br>`llm` **+ `mode: summarize\|extract\|rewrite\|classify\|freeform`**<br>`assemble` · `search_web` · `deliver` |
| **Control (new, closed)** | — | **`decision`** · **`branch`** · **`foreach`** · **`human`** · **`wait`** |
| **Attributes (any node)** | — | `on_error: { retry, then: 'escalate'\|'route_to:<id>' }`<br>`idempotency: { key, on_conflict: 'skip'\|'update'\|'error' }` |
| **Delete** | — | `tool`, `mcp-tool`, `fetch` *(dead — no ToolRegistry)* |

**DONE — Increment A.** The work axis is now `trigger · llm · assemble · connector-action ·
search_web · deliver`. Two corrections to what this table originally said, both forced by the code:

- **`daily-digest` was NOT a preset of `llm`, and did not collapse into it.** Its `run()` never
  touched `services.llm` — it took `(cfg, _ctx, _services)` and did pure string templating. Folding
  it into `llm` would have converted a free, deterministic, instant string operation into a paid,
  non-deterministic model call. It kept its exact `run()` and config and was **renamed to
  `assemble`** (`node-types/assemble.js`); v1 specs saying `daily_digest` lift to it. It is the one
  entry in the original re-cut table that was wrong on the facts.
- `search_web` stays. It is runnable and it is not an `llm` mode.

> **Hard rule: the converger COMPOSES from this closed vocabulary. It never DEFINES node types.**
> Free-form node shapes make gap analysis, overlap detection and "you declared an output that
> isn't wired" impossible — i.e. they delete the moat. Defects #1 and #3 are what a *partially*
> open grammar already costs.

### 2.4 New proposal vocabulary
`proposal.component` gains:
```
outcome · assertion · example · decision · rule · hit_policy · branch · foreach · human · on_error · idempotency
```
(existing: `trigger · node · edge · name · description · remove_node · remove_edge · setup_action`)

### 2.5 New interrupt types
```
outcome_check   — "here's the contract I heard; is it right?"
example_request — "show me 3 cases"
decision_review — renders a TABLE, not prose
gap_review      — "3 cases you haven't told me about" [Answer | Escalate (default) | Ignore]
```
(existing `clarification · proposal · ratify · done` stay.)

---

## 3. DELTA: `src/converger/`

### `gap-scorer.js` → **rewrite** (this is the heart) — ✅ **DONE (Increment C)**

```js
// BEFORE
scoreGap(draft) → { needsTrigger, needsProcessing, needsDelivery, needsEdges, needsName, complete }

// AFTER
scoreGap(spec, { capabilities }) → {
  gaps: [ {
    id, class: 'outcome'|'coverage'|'contract',
    nodeId, code, severity, message, hint,
    resolution: 'unanswered' | 'answered' | 'escalated',
    decidable: boolean,         // false when the domain is infinite (say so in the UI)
    blocking:  boolean          // this gap makes the spec fail validation
  } ],
  complete: boolean             // no gap is left 'unanswered'
}
```

> ⚠️ **CORRECTED (Increment C).** This section used to say `resolution` defaults to **`'escalated'`**,
> full stop. **That is not merely wrong, it is unimplementable**: if every gap defaults to escalated
> then `complete` is unconditionally TRUE, so an **empty draft scores complete** and the converger
> ratifies a workflow with no steps in it. A default that makes a check vacuous is not a safety net;
> it is the bug. (Same class as the `?? 'unscoped'` tenant fallback that leaked across tenants in
> Increment B.)
>
> The rule that actually holds:
>
> - A gap defaults to **`'escalated'`** — nobody answered it, so a human deals with it. This is what
>   makes *"Accept all defaults"* honest rather than a way to hide unknowns.
> - **A BLOCKING gap — one that makes the spec fail validation — always defaults to `'unanswered'`.**
>   It *cannot* be escalated, because escalation promises a person will handle the case **at run
>   time**, and a spec that cannot publish never has a run time. Calling that "escalated" would be a
>   lie told in the language of safety.
>
> Which buys the property the whole loop rests on:
>
> > **`complete ⇒ publishable`.**
>
> Without it the converger can declare a workflow finished that `POST /api/builder/workflows` then
> rejects — a dead end the user cannot argue their way out of: the builder says done, the save button
> says no.

> ⚠️ **AND IT ONLY HOLDS IF THE SCORER FAILS CLOSED.** This section used to claim the property held
> "by construction". It did not, and the independent verifier produced the counter-example.
>
> `scoreGap` judges a spec with the validator — but the validator's channel checks
> (`UNKNOWN_CHANNEL`, `CHANNEL_UNAVAILABLE`) sit behind `if (channelId && this.channelRegistry)`, so
> **with no channel catalog they silently do not run**, while publish — which always has a registry
> (`server.js:542`) — still enforces them. A `deliver` to a hallucinated `channel: 'discord'`
> therefore scored **complete**, and then failed to publish.
>
> It disabled itself exactly when it mattered most: `builder.js` builds the catalog *after* three
> network-bound connector lookups inside a *"non-fatal"* catch, so an expired refresh token dropped
> it — and in that same state the model has no catalog in its prompt either, making it **most** likely
> to invent a channel id.
>
> **A check that silently degrades is not a safety net; it is the bug** (CLAUDE.md — the
> `?? 'unscoped'` tenant fallback). So the scorer now **refuses to certify** when it cannot see the
> catalog (`CHANNELS_UNVERIFIED`, blocking), and `builder.js` guarantees one.
> **Refusing to certify is always available. Certifying without checking is not.**
>
> And the check built to *prove* this property — `converger-adversarial.mjs` check 6 — was
> **structurally incapable of failing**: it scored with no capabilities and validated with no
> registry, so both sides were equally blind and the divergence was invisible *by construction*.
> That is CLAUDE.md architectural flaw #2 verbatim — *a check that exercises a configuration
> production never uses cannot see the bug production has*. It now validates the way production
> validates.

**The contract and outcome gaps ARE the validator's issues**, classified — `gap-scorer.js` does not
re-implement them. That is deliberate: a converger holding its own private opinion of "complete"
drifts from the publish gate, and the day it drifts is the day it ratifies an unpublishable spec.
One oracle, consulted by both, cannot drift. What the gap scorer adds on top is the DMN coverage
analysis (`decision-analysis.js`), which the validator does not do until Increment E.

**The outcome contract is a FLOOR, not a ceiling.** It guarantees nothing the user asked for was
silently **dropped** — that is what kills defect #1. It cannot guarantee every transformation they
asked for is **present**, because *"a summary of the email"* and *"the email"* arrive at Slack as the
same assertion (`message_sent → slack:#logistics`), and no machine-checkable assertion distinguishes
them. So once the gap floor is met, the INTENT still gets the last word: `analyze` asks the model
once whether the draft is finished, and it must **name a concrete missing component** to continue
(`buildSufficiencyPrompt`, bounded). Note the difference from v1's checklist, which *demanded* a
processing node and so invented one for workflows that genuinely had none (defect #4) — here
"finished" is the default answer, and a 2-node workflow ratifies untouched.

Three gap classes:
1. **outcome** — an `assertion` with no node that satisfies it. *(kills defect #1)*
2. **coverage** — a `decision` table with uncovered input combinations (enumerable domains
   only), a table whose `hitPolicy` is `UNIQUE` but has overlapping rules, or a `branch` with
   no `*` case. *(kills defect #5)*
3. **contract** — required config field unset; unknown config key; write node with no
   `idempotency`; node with no `on_error`. *(kills defect #3)*

**Gap analysis = the hyper-rectangle method** (Calvanese et al.). Enumerate the cross-product of
enumerable input domains; a rule is a box; report uncovered regions. **Only decidable over
enums / bounded ints / booleans** — mark everything else `decidable: false` and require a
catch-all instead. **Do not imply a proof we cannot make.**

### `elicitation-graph.js` → new nodes — ✅ **DONE (Increment C)**
```
outcome   (new, interactive)     → 2-3 candidate contracts; the first is pre-selected
examples  (new, interactive)     → proposes concrete cases; keeping them is the default, skip is one click
process   (new, non-interactive) → backward-chains the graph from the assertions. No LLM call.
analyze   (existing)             → now gap-driven by the new oracle, not the old 5-item checklist
clarify   (existing)             → unchanged
propose   (existing)             → now told the validator's own message AND hint for each gap
gaps      (new, interactive)     → presents the gap list; default resolution = escalate
ratify    (existing)             → confirm; emit spec v2
```
Routing: `outcome → examples → process → (analyze ⇄ clarify|propose) → gaps → ratify`.
`analyze`/`clarify`/`propose` are v1's loop, kept intact. Two loop BOUNDS were added
(`proposeRounds`, `gapRounds`): a gap the model cannot close would otherwise spin to the recursion
limit and die with a stack trace instead of asking the user a question.

> **There is no `decisions` graph node, and there must not be one yet.** This section originally
> listed one that "builds tables from examples". It cannot: **the `decision` node type does not
> exist until Increment E**, so a `decisions` node could only emit a spec the engine cannot run —
> the same trap as surfacing `human` before Increment D builds the surface that asks it. In the
> runnable vocabulary a decision today is **`llm` + `mode: 'classify'` feeding a `branch`**, and
> that is what the converger proposes when the intent needs a judgement (`buildDecisionPrompt`
> exists and teaches exactly that shape). `LLM_INPUT_NOT_ENUM` is what forces `classify` rather
> than free prose. E replaces this with the real table.

**`process` is deterministic and it is load-bearing.** For each assertion whose satisfying node is
unambiguous (`nodeForAssertion` — "post to #logistics" has exactly one shape), it builds the node
directly: no LLM round-trip, and — the real point — **the delivery node is derived FROM the
assertion, so it cannot target a different channel than the one the user just confirmed.** The
contract and the spec agree by construction rather than by the model's good behaviour. Where the
shape is *not* derivable (an Airtable write needs a base and a table — Increment F reads those from
the connector), nothing is invented: the assertion stays an open gap and `propose` fills it.

### `spec-assembler.js`
- `applyProposal` — add cases for the new components (§2.4).
- `assembleSpec(draft)` — emit `version: 2`, `outcome{statement, assertions, examples}`.

### `prompts.js`
- New: `buildOutcomePrompt()`, `buildExamplesPrompt()`, `buildDecisionPrompt()` (induce a table
  from examples), `buildProcessPrompt()` (backward-chain).
- **The system prompt must enumerate the closed node vocabulary AND the exact template grammar**
  (`{{prev}}`, `{{<id>.output}}`, `{{date}}`…). Defect #3 exists because it doesn't.

### `interaction-store.js`
- Store `provenance`: which turn/quote produced each assertion and rule; which gaps were
  escalated by default. **Feeds the SOP.** Keep it in the store, not the spec.

---

## 4. DELTA: `src/workflows/` (engine)

### `flow-tester.js` — conditional execution — **DONE (Increment B)**

**Liveness is tracked on EDGES, not on a node-level `active` set** — this section originally
specified the latter, and it is wrong. A node-level "all my parents are inactive ⇒ skip me" rule
gets **joins** wrong: a node downstream of BOTH the taken and the untaken path has one inactive
parent and one active one, and would be skipped by any rule phrased over parent *nodes*. In the
canonical approve/reject shape — `branch → send | drop`, both feeding a final `notify` — that
silently deletes the notify step. So:

- An **edge** is live once its source completes. Out of a `branch`, only the selected case's edge
  goes live; the rest stay dark.
- A node is **skipped** iff it has at least one incoming edge and **none** of them is live. A root
  (no incoming edges) always runs. A join runs as soon as **one** incoming edge is live — which is
  the correct semantics, and the one BPMN uses.
- **A ruled-out branch target is DEAD, not merely unlit.** Liveness alone is not enough: if an
  untaken case target also has an edge from some earlier node, *that* edge is live whichever way
  the branch went, so the step would run anyway and **the branch would have decided nothing**. The
  engine therefore marks non-selected case targets dead outright, and the validator rejects the
  ambiguous shape at build time (`BRANCH_TARGET_EXTRA_PARENT`) — a case target must be reachable
  **only** through its branch. To use another step's data, reference it with `{{stepId.output}}`;
  a template needs no edge.
- A skipped node emits `step_skipped` — **not** `step_failed`. It is not a casualty.
- **§11.2 then holds structurally, not by promise:** with no `branch` in the spec every edge goes
  live the instant its source completes, nothing is ever skipped, and the loop reduces to exactly
  the old one. `tests/workflows/control-flow.test.js` asserts the event sequence is unchanged.

### New node types (`src/workflows/node-types/`)
| Type | `run(cfg, ctx, services)` behaviour | Status |
|---|---|---|
| `branch` | Evaluate `on`; select one `case`; the rest of the edges stay dark. Matching is exact-value only — no expressions. An expression language here would be undecidable, which deletes the completeness proof; ranges belong in a `decision` table, where they can be gap-analysed. | **DONE (B)** |
| `foreach` | Iterate `over` a collection, binding `{{item}}`/`{{index}}`; collect outputs. **`maxItems` (default 100)**. The bound really stops the work, and the truncation is **reported** (`truncated`, `skipped`) — a loop that quietly processed 100 of your 500 rows is worse than one that failed. One level; no nesting (§12). | **DONE (B)** |
| `human` | **Durable pause.** Run status `awaiting_human`; resume from the run's `checkpoint` (NOT the persisted steps — see §7.4). The ENGINE half is built; the ask-delivery and the authentication of the answer are **Increment D**. **Full design: §7 — read it before touching this.** | **engine DONE (B)**; channels D |
| `decision` | Evaluate `inputs` (LLM inputs = **classify into the declared enum**, one call per fuzzy input for auditability), match `rules` under `hitPolicy`, return the output value. Emit which rule fired → audit trail. | E |
| `wait` | Timer. | not built — no gate check and nothing needs it yet |

### Node attributes — **DONE (Increment B)**
| Attribute | Behaviour |
|---|---|
| `on_error: { retry, retry_delay_ms, then }` | `retry` = EXTRA attempts (`retry: 2` ⇒ up to 3 tries). `then: 'route_to:<id>'` lights that edge and the run **continues** down a declared failure path — the happy path stays dark. `then: 'escalate'` still fails the run but **flags** it (`escalated: true`) rather than losing it in a log; Increment D turns that flag into an Approvals-inbox item. It deliberately does NOT pause — a pause nobody can answer is a hang. |
| `idempotency: { key, on_conflict }` | Backed by `src/workflows/idempotency-store.js` (SHA-256 of the resolved key, scoped `workflowId:nodeId`). `skip` (default) does not re-run and hands back the FIRST run's output, so downstream steps still have their input. `update` re-runs; `error` fails loudly. **A node that declares a key with no store wired refuses to run** — a step that claims to deduplicate and silently doesn't is worse than one that never claimed to. |

### `llm.js` — add `mode` — **DONE (Increment A)**
`mode: summarize | extract | rewrite | classify | freeform`. `summarize.js`, `extract.js`,
`rewrite.js`, `tool.js`, `mcp-tool.js`, `fetch.js` are **deleted**; `daily-digest.js` was renamed
to `assemble.js` (see §2.3 — it was never an LLM node). The v1 compat shim is
**`node-types/compat-v1.js`**:

- `liftV1Node(node)` maps `summarize|extract|rewrite → llm + mode`, and `daily_digest → assemble`.
  The v1 config keys (`instructions`, `format`, `fields`, `length`, `style`, `tone`, `focus`,
  `input`) are all declared on the v2 `llm` schema **under the same names**, so the lift is a type
  swap plus a `mode` — no key renaming, no config dropped.
- `tool` / `mcp_tool` / `fetch` are **not** lifted — they have no v2 equivalent, and none of them
  could ever run. They are rejected by name as `REMOVED_NODE_TYPE`, with a hint naming the
  replacement. That converts a 6am runtime failure into a build-time one.
- It is called in exactly **two** places — `WorkflowValidator.validate()` and
  `FlowTester._runNode()`. Both the scheduler and the REST run path execute through FlowTester, so
  those two call sites cover every way a workflow can validate or run. **Nothing in the database
  was migrated**: a v1 spec is lifted on read, never rewritten on disk, so the shim can be deleted
  in one move once no v1 specs remain.

`classify` is new and is load-bearing for Increment C: it is the only sanctioned way for an LLM to
feed a `decision`, because it classifies into a **closed enum** (`categories`) instead of emitting
free text. `llm.js` rejects an off-enum answer at run time rather than passing it downstream — an
unclassifiable input is exactly the case a decision must escalate on. See §11.7.

### Schema-aware connectors (unblocks the write story)
New capabilities: `airtable_list_bases`, `airtable_describe_table`, `sheets_describe`.
The converger reads the destination's field names and maps *"the customer's budget"* → the
`Deal Size` column **itself**. Today the user must paste an opaque base ID — which is precisely
where "just talk to it" dies.

---

## 5. DELTA: `workflow-validator.js`

| New code | Rule | Kills | Status |
|---|---|---|---|
| `UNKNOWN_CONFIG_KEY` | node config keys ⊆ the type's `configSchema`, **for `configPolicy: 'closed'` types** | **#3** | **DONE (A)** |
| `REMOVED_NODE_TYPE` | `tool` / `mcp_tool` / `fetch` are rejected by name | dead node types | **DONE (A)** |
| `UNKNOWN_LLM_MODE` | `llm.mode` ∈ the five modes | typo'd mode | **DONE (A)** |
| `UNSATISFIED_ASSERTION` | every `outcome.assertions[]` maps to ≥1 node that satisfies it | **#1** | **DONE (C)** |
| `MALFORMED_ASSERTION` | an assertion we cannot CHECK (unknown `kind`, no `target`) is an error, never a silent pass | **#1** | **DONE (C)** |
| `MISSING_OUTCOME` | a spec declaring `version: 2` must carry an outcome with ≥1 assertion | **#1** | **DONE (C)** |
| `LLM_INPUT_NOT_ENUM` | an LLM-evaluated decision input **must** be `type:'enum'` with `values` | **protects the moat** | **DONE (C)** |
| `NON_EXHAUSTIVE_BRANCH` | every `branch` has a `*` case | **#5** | **DONE (B)** |
| `BRANCH_CASE_NO_EDGE` | a case's target must have an edge from the branch — without one it sorts BEFORE the branch topologically and runs unconditionally, so the routing silently does nothing | silent no-op routing | **DONE (B)** |
| `BRANCH_TARGET_EXTRA_PARENT` | a case target must be reachable ONLY through its branch — a second incoming edge is live whichever way the branch went, so the step runs even when it was ruled out | a branch that decides nothing | **DONE (B)** |
| `ON_ERROR_ROUTE_NO_EDGE` · `ON_ERROR_BAD_TARGET` | `route_to:<id>` needs an edge from the failing node (which is what guarantees the target sorts *after* it) — without one the failure path never runs and the workflow reports **success** | an unhandled error reported as a success | **DONE (B)** |
| `NESTED_FOREACH` · `HUMAN_IN_FOREACH` | one loop level (§12); a pause inside a loop would need one durable pause per item, and the resume model is per-RUN | a loop that pauses on item 1 and never processes 2..N | **DONE (B)** |
| `DECISION_TABLE_GAP` | enumerable inputs fully covered, or a catch-all rule exists | **#5** | E |
| `UNIQUE_HIT_OVERLAP` | `hitPolicy: UNIQUE` but rules overlap | **#5** | E |
| `WRITE_WITHOUT_IDEMPOTENCY` | **warning** on write capabilities lacking `idempotency` | duplicate records | **DONE (B)** |

`UNKNOWN_CONFIG_KEY` is the highest-leverage check: it turns "the converger hallucinated a
field" from a silent production failure into a build-time error.

#### `LLM_INPUT_NOT_ENUM` covers TWO shapes, not one (Increment C)

The rule as written names only a `decision` input. Implemented that narrowly it would have guarded
**nothing that can run**: `decision` is not a registered node type until Increment E, so in C the
check would have been pure theatre — a symbol in the validator that no reachable spec could ever
trip. Meanwhile the shape that *can* run today has exactly the same defect:

> a **`branch`** routing on an **`llm`** node that is not in `classify` mode.

A branch matches its cases by **exact value**. Routing on free prose (*"This seems quite urgent, I'd
say"*) matches no case, so the **mandatory catch-all silently swallows 100% of traffic** — with
`run_completed` and no error. That is verbatim the `BRANCH_BAD_ON` failure (CLAUDE.md: *"the
catch-all that exists to prevent a silent misroute was masking one"*), arriving through a different
door. An LLM feeding a decision is an LLM feeding a decision, whichever node type spells it.

So the validator enforces the rule on **both**, and `classify` — which returns exactly one of a
closed set and throws on anything else — is the sanctioned way through. This also gave the one place
Increment C had to touch a prior increment's test: `tests/workflows/control-flow.test.js`'s
"routing on a step an earlier branch SKIPPED" fixture used a *freeform* `llm` as the routed-on node.
The mode was incidental to the invariant that test pins (a skipped step's value takes the catch-all
rather than crashing); it was changed to `classify`, the assertion left untouched, and the test
re-mutation-tested to confirm it still goes red when the original defect is restored.

> ⚠️ **AND IT MUST BE AN ALLOWLIST.** The first implementation asked *"is the branch's source an
> `llm` node that isn't classifying?"* — a **denylist** — and the test-adversary bypassed it with a
> single hop: put an `assemble` between the freeform `llm` and the `branch`
> (`content: "{{think.output}}"`, a shape the converger is *taught* to emit) and the check never
> fires. `validator.ok === true`, `scoreGap.complete === true`, and the branch routes on free prose:
> nothing matches, and the mandatory catch-all silently swallows 100% of traffic. Same hole through
> `search_web` and `connector-action`.
>
> **The property §11.7 requires is "the routed-on value has a CLOSED, DECLARED domain" — not "its
> parent isn't an LLM".** Laundering a value through another node does not bound its domain; it only
> hides who produced it. A branch may therefore route ONLY on:
>
> | Source | Its closed domain |
> |---|---|
> | `llm` + `mode: 'classify'` | `categories` (and `run()` throws on an off-enum answer) |
> | `decision` | `output.values` (Increment E) |
> | `human` | `decisions` — approve / reject / timeout (Increment D) |
>
> **A new source type earns its place on that list by declaring the set of values it can emit.** If
> you add one without a declared value set, you have deleted the completeness proof — which is the
> product. A denylist here is wrong *by construction*, and it fails silently.

#### A `deliver` node's keys are deliver's ∪ the CHANNEL's (Increment C fix)

Increment A judged every `deliver` node against `deliver`'s own `configSchema` alone. **That was a
live defect, and it was shipped.** A delivery channel is a *capability with its own parameters*:
`sheets_append`'s handler reads `config.spreadsheetId` and `config.range`
(`src/connectors/google/index.js:694`); `airtable_create_record` reads `baseId` / `tableId` /
`fields`. None is a `deliver` key — so **every delivery to a Sheet or an Airtable base was rejected
at publish with `UNKNOWN_CONFIG_KEY`**, while the converger's own system prompt rendered exactly
that shape from the channel catalog and instructed the model to emit it. The builder was telling
users to build workflows it would then refuse to save. Slack and Gmail escaped only because their
keys happen to overlap `deliver`'s own.

The fix **narrows a lie in the schema; it does not widen the check**: a deliver node's keys are now
checked against `deliver`'s schema **∪ the selected channel's own `configSchema`**. `model` is still
rejected. `message` is still rejected. The keys judged against are simply the true ones. This is why
`scoreGap()` takes `capabilities` — it hands the validator the same channel catalog the server has,
which is what keeps `complete ⇒ publishable` true rather than aspirational.

#### `UNKNOWN_CONFIG_KEY` is scoped by `configPolicy` — and it has to be

This section originally stated the rule as a blanket "node config keys ⊆ the type's
`configSchema`". **Implemented literally, that rejects the frozen canonical spec and every
connector workflow in production.** Grounded against `main` before building Increment A:

- The **frozen canonical spec**'s `summarize` node carries `instructions` and `format`. The v1
  `summarize` schema declared neither (`length`, `style`, `focus`, `input`). So the blanket rule
  fails `docs/specs/canonical-ups-slack.json` → **P3 dies** (§11.1). *(It also means the canonical
  workflow's carefully-written instructions were being silently dropped at run time — the same
  class of bug as defect #3, in the fixture we validate against. The v2 `llm` node honours them.)*
- **`deliver`** nodes across the shipped corpus carry `target`, `user`, `to`, `subject`,
  `username`, `icon_emoji`. **Every one is read by a real handler** — `config.target`
  `slack/index.js:256`, `config.user` `:278`, `config.username` `:259`, `config.icon_emoji` `:260`,
  `config.to` / `config.subject` `google/index.js:591`. They were simply never *declared*, so a
  blanket rule rejects the ordinary Slack and Gmail delivery shapes.
- **`connector-action`** params are **per-capability** (`baseId`, `tableId`, `filterByFormula`,
  `spreadsheetId`, `range`, …). They cannot be enumerated in a static schema, because the
  capability catalog is built at run time from the tenant's authorised connectors.

So each node type declares **`configPolicy`**, defaulting to **`'closed'`** — a type opts *in* to
being unchecked, it does not get there by omission:

| Type | Policy | Why |
|---|---|---|
| `llm`, `deliver`, `assemble`, `trigger`, `search_web` | `closed` | Fixed, knowable key set. Subset enforced. |
| `connector-action` | `open` | Params are per-capability. **The only hole in the check.** |

The two failure modes look identical and are not the same thing, and telling them apart is the
entire value of the check:

- a key **no code reads** (`llm.model`) is a hallucination → **error**;
- a key **a handler reads but the schema never declared** (`deliver.target`) is an **untrue
  schema** → *fix the schema*, do not relax the check.

**Declaring a key that `run()` does not consume turns this check into theatre. Don't — and prove
the consumer before you declare, with a word-boundary grep.** This is not hypothetical: Increment A
briefly declared `deliver.message` on a misread — a grep for `config.message` **prefix-matched
`config.messageId`**, a `gmail_get_message` parameter — and the independent verifier caught it.
Nothing reads `config.message`, so a `deliver` node carrying it has its content **silently
discarded** at run time: the user writes *"post exactly this greeting"* and gets the upstream LLM's
output instead, and is never told. Declaring the key to make that spec pass would have re-created
defect #3 **inside the very check built to kill it**. It is rejected, and
`tests/workflows/validator-config-keys.test.js` pins it that way.

> **Increment F closes the `connector-action` hole** by validating params against each
> capability's *own* declared schema — that is what "schema-aware connectors" buys, beyond base
> discovery. Until F lands, `connector-action` is unchecked, and it is the only node type that is.

---

## 6. DELTA: the elicitation UI

> The UI is **not** a downstream skin on the converger. It is *half of the moat*. The closed
> vocabulary that makes the completeness proof possible (`decisions[].inputs[].values`, the
> connected capability catalog, the induced gap set) is **the same thing that makes multiple
> choice possible**. A pure-LLM competitor cannot render this screen, because it does not know
> what the finite set of answers *is*.

### 6.1 The problem this solves

v2 asks for strictly more than v1: an outcome contract, worked examples, decision inputs, hit
policies, exception paths. Elicited as free-text chat turns, that is a **40-question
interrogation** and it will kill activation stone dead — which matters, because prod today is
**5 signups, 1 workflow, 0 subscriptions**. Activation is the actual business problem; a v2 that
elicits more but converts less is a net loss.

The fix is a shift in interaction model:

| | v1 (today) | v2 |
|---|---|---|
| Who produces the answer | The **user**, by typing | The **system**, by proposing |
| What the user does | Recall and articulate | **Recognise and correct** |
| Cost of a turn | A sentence | **A click** |
| Cost of not knowing | Blocked | **Accept the default, ship anyway** |

### 6.2 Design principles (load-bearing — an agent must not violate these)

1. **Recognition over recall.** People cannot articulate their own rules. They *instantly*
   recognise a wrong one. Never ask an open question where a closed one is available. Every
   turn is *"here is my best guess — correct me."*
2. **The system proposes, the user disposes.** Every interrupt ships with a **pre-selected
   default**. `Enter` is always a valid answer.
3. **Never ask for something we can read.** We hold OAuth tokens for the user's Gmail, Slack,
   Airtable, Drive. Asking the user to *type* an example email — when `gmail_search` can list
   three real ones to pick from — is a self-inflicted wound. This principle generalises: table
   names, channel lists, field names, label names. **Read it, render it, let them pick.**
4. **Accept-all-defaults must always be one click away.** A user must be able to publish a
   provably-complete workflow **having answered nothing**, because the default resolution for
   every unknown is *"escalate to a human"* (§7) — which is safe, correct, and honest.
5. **Progressive disclosure.** Depth is opt-in. The decision table is *reviewed*, not
   *authored* — collapsed to a sentence, expandable to the grid.
6. **Free text is always available.** Chips never *replace* the composer; they sit above it. An
   expert who wants to type a paragraph must never be forced through a wizard.

### 6.3 Interrupt → component map

`public/index.html` switches on `iv.type`. Today: `clarification | proposal | ratify | done`.
v2 adds four, each with a payload shape the client renders **without** knowing the domain:

| `iv.type` | Component | Payload | Default |
|---|---|---|---|
| `outcome_check` | **Outcome cards** — 2–3 candidate contracts, pick one or edit | `{ candidates: [{ id, statement, assertions[] }] }` | `candidates[0]` |
| `example_request` | **Example picker** — real records fetched from a connected source | `{ source: 'gmail'\|'airtable'\|…, query, items: [{ id, preview, raw }], allowManual: true }` | none *(user picks ≥1)* |
| `decision_review` | **Decision table** — read-mostly grid; cells are dropdowns over `values` | `{ decisionId, inputs[], rules[], hitPolicy, hitPolicyOptions[] }` | the induced table, unmodified |
| `gap_review` | **Gap list** — one row per uncovered case, each `Answer ▾ / Escalate / Ignore` | `{ gaps: [{ id, description, suggestedAnswers[], defaultResolution: 'escalate' }] }` | **escalate, all rows** |

Two shared primitives, reusable by *any* interrupt (including today's `clarification`):

- **`choices[]`** — `{ id, label, hint?, selected? }`. Renders as chips. `multi: true` ⇒
  checkboxes. **Any interrupt may carry `choices[]`**; this is how a `clarification` stops being
  a blank text box. Adding `choices` to an existing interrupt is backward-compatible — a client
  that ignores it still shows the composer.
- **`assertionBuilder`** — `{ verbs[], objects[], targets[] }` where `targets` is drawn from the
  **connected capability catalog**. Composes *"[create] [a record] in [Airtable · Deals]"* from
  three dropdowns. This is the outcome contract, built without typing.

### 6.4 Per-phase surfaces

**Outcome.** 2–3 outcome cards — *"Which did you mean?"* — each showing the statement plus its
assertions. Below: the assertion builder (chips → catalog targets). The chosen card is **pinned
above the chat for the rest of the session** and stays editable. It is the contract; it must
never scroll away.

**Examples — the biggest single unlock.** Do **not** ask the user to invent test cases; they
will invent easy ones. Call `gmail_search` (already built) and render *"Pick 3 emails that
should trigger this"* + *"Pick 1 that should NOT"* from their real inbox. Zero typing, and the
negative example is the one that finds the bug. Falls back to manual entry when no source is
connected (`allowManual`).

**Decisions.** Render the **induced** table for review. Cells are dropdowns — the enum values
are known, that is the whole point of `LLM_INPUT_NOT_ENUM`. Hit policy is a radio in plain
language, never the DMN letter:

| Radio label | DMN |
|---|---|
| *"Only one rule should ever match"* | `UNIQUE` |
| *"First match wins"* | `FIRST` |
| *"Collect everything that matches"* | `COLLECT` |

**Gaps — the killer surface.** *"You haven't told me what to do in these 3 cases."* Each row:
**Answer ▾** (pre-filled with the model's suggestion) · **Escalate to me** *(pre-selected)* ·
**Ignore**. A single **"Accept all defaults"** button resolves every row to *escalate* and
publishes. The user ships a **provably complete** workflow having answered nothing, and the gaps
become a backlog that fills in as real escalations arrive. This is the mechanism that lets v2
demand more rigour **without** demanding more typing — and it is why §7 is a hard dependency,
not a nice-to-have.

### 6.5 Framework constraints (an agent WILL hit these — CLAUDE.md gotchas)

- **`sc-if` / `sc-for` are visible DOM nodes until `support.js` compiles them.** The global
  `sc-if, sc-for { display: none; }` rule at `public/index.html:135` is what stops the browser
  computing child styles early. **Never** put `<img src="{{…}}">` or `background:url('{{…}}')`
  inside a template element — the browser fetches the *uninterpolated* URL and 404s.
- **Event attributes must resolve through `EVENT_MAP`** (`public/support.js:298`). HTML lowercases
  attribute names, so `EVENT_MAP` maps `onclick → onClick`, `onkeydown → onKeyDown`, etc. An
  event **absent** from the map hits the fallback at `support.js:390`
  (`"on" + key[2].toUpperCase() + key.slice(3)`), which yields `onDragover` — **not** a valid
  React prop, and it silently does nothing. **If you need an event that isn't in `EVENT_MAP`, add
  it to `EVENT_MAP`.** Existing usage: `onClick` ×146, `onInput` ×17, `onKeydown`/`onKeyDown` ×8,
  `onBlur` ×3, `onDrop` ×2.
- **`index.html` on the marketing site stores markup as a JSON string** inside
  `<script type="__bundler/template">`. Not this repo — but the same trap exists for any
  templated fragment: a find-string containing no quotes and no slashes matches **identically**
  in both plain and JSON-escaped encodings. Choose the encoding by **file**, and re-validate the
  JSON before writing.

### 6.6 API

- `POST /api/builder/sessions/:threadId/respond` accepts the new payloads. The response envelope
  gains an optional `choices[]` / `assertionBuilder` on **any** interrupt — additive, so a v1
  client degrades to the plain composer rather than breaking.
- **Test panel becomes the outcome oracle.** It stops asking *"does this look right?"* and starts
  asserting `outcome.examples` — pass/fail against the contract. Strict upgrade to the single
  most persuasive moment in the demo.
- **SOP export** (`sop-generator.js`, `sop-pdf.js`) gains outcome + decision tables + escalation
  policy + provenance. That is the consultant's deliverable.

---

## 7. DELTA: human-in-the-loop — the `human` approval gate

> Maps to BPMN's **User Task** + a **boundary timer event** + an **escalation path**. This is a
> standard shape, not an Atlas invention — say so to a compliance buyer.

A `human` node is **two halves**: an **ask**, delivered over one or more channels, and an
**answer**, captured back — *authenticated, single-use, and idempotent*.

### 7.1 Node shape

```jsonc
{
  "id": "approve_send",
  "type": "human",
  "config": {
    "prompt": "Send this reply to {{extract.customer_email}}?",
    "preview": "{{draft_reply.output}}",          // what the approver actually sees
    "decisions": ["approve", "reject"],           // later: "edit"
    "channels": [                                  // ask over ALL; first valid answer wins
      { "type": "slack", "target": "#ops" },
      { "type": "inbox", "assignee": "user:abc" },
      { "type": "email", "to": "ops@acme.com" }
    ],
    "quorum": 1,
    "timeout": { "after": "48h", "then": "escalate", "escalateTo": "inbox:owner" }
  }
}
```

Outputs `{{approve_send.decision}}` (`approve|reject|timeout`), `.by`, `.at`, `.channel` — so a
downstream `branch` routes on it and the run log carries **who approved what, when, over which
channel**. That is the audit trail.

### 7.2 Channels and their trust levels — *the crux*

An approval that anyone can forge is not an approval. Channels are **not interchangeable**:

| Channel | Ask | Answer | Trust | Proves |
|---|---|---|---|---|
| `inbox` | In-app item (`src/inbox/`) | Click, authenticated session | **strong** | *This user*, logged in |
| `slack` | Block Kit message + buttons | `block_actions` → HMAC-verified with `SLACK_SIGNING_SECRET`, carries `user.id` | **strong** | *Which Slack user* clicked |
| `email` | Email with **signed magic links** | `GET /approvals/:token` — hashed, single-use, TTL | **medium** | Possession of the link (i.e. mailbox access). **Forwardable.** |
| ~~`email_reply`~~ | — | Parse `"yes"` from a reply body | **FORBIDDEN** | *Nothing.* `From:` is trivially spoofable |

**Hard rule: never authenticate an approval by parsing an email reply.** SPF/DKIM authenticate a
*sending domain*, not a *human intent*; and the body of a forwarded thread is full of the word
"yes". Email approvals use a **signed magic link** or they do not exist.

**Hard rule: the channel must be at least as strong as the action is risky.** A write capability
(create a record, send a customer email, move money) behind a `medium`-trust approval is a
validator **error**, not a warning.

### 7.3 Token model — reuse the password-reset pattern verbatim

`src/auth/password-reset-store.js` already solved this and is battle-tested. `ApprovalStore`
mirrors it exactly:

- `newApprovalToken()` → 32 random bytes, base64url.
- Store the **SHA-256 hash only**. The raw token exists solely in the email.
- **Single-use** — consumed on first valid click.
- **TTL**, defaulting to the node's `timeout.after`.
- **One token per `(runId, nodeId, decision)`.** Approve and reject are *different* tokens, so a
  forwarded "approve" link cannot be flipped to "reject" by editing a query param. Consuming
  either invalidates **both** — one approval, one answer.

### 7.4 Durable pause — the engine mechanics

**No StateGraph checkpointer is needed, and adding one would be a mistake.** The DAG is
deterministic and topologically ordered, so the checkpoint is a plain object.

> ⚠️ **CORRECTED (Increment B).** This section used to say the checkpoint *was*
> `workflow_runs.steps` — "appendStep already persists every node's result". **That is false, and
> it silently corrupted the work product.** `steps` holds the **display-shrunk event stream**:
> `_shrinkOutput` truncates at 2000 chars, appends a literal `…(truncated)`, and JSON-encodes
> objects, so the UI isn't flooded. Resuming from it meant a 3363-char drafted email came back as
> 2013 chars — **the person approved one thing and the customer received a different, mutilated
> one**, with no error and `run_completed`. 2000 chars is ~400 words; a routine drafted reply
> exceeds it, so *every* real approval would have resumed on corrupt state.
>
> The run therefore emits an explicit **`checkpoint`** on `run_paused` —
> `{ outputs, skipped, live, ruledOut, lastOutput }`, **full fidelity, un-shrunk** — which the
> scheduler stores in
> `workflow_runs.checkpoint`. It is written only on a pause, so it costs nothing on runs that never
> pause. `steps` remains the UI/history record and is **not** resume state.
>
> **The rule: anything that reads back a persisted step gets a display copy, not the live value.**

Therefore:

- Run status **`awaiting_human`** (new).
- **On pause:** persist, emit the asks, return. The run holds **no compute** while it waits —
  a pending approval is free.
- **On resume:** rehydrate `ctx.outputs` from the **checkpoint** (not the steps — see the box
  above), inject the decision as the `human` node's output, and continue the topological order from
  the next node.
  - ⚠️ Nodes **skipped** before the pause must be tracked separately from **completed** ones
    (`skipped[]` in the checkpoint). Lump them together and a skipped node relights its own
    children on the way back through, reviving a dead subtree the branch had ruled out.
  - ⚠️ **A `branch` and a `human` are CONTROL nodes: their output is never `lastOutput`.** A
    branch's output is `{value, matched, to}` and a human's is `{decision, by, at, channel}` —
    routing and audit metadata, not the work product. `deliver` sends `ctx.lastOutput`, so leaving
    them in means the delivery after an approval sends the literal
    `{"decision":"approve","by":"user:1",…}` to the customer instead of the reply that was
    approved. The content is the draft **above** the approval.
- **The scheduler must skip `awaiting_human` runs** — it must not re-fire them.
- A **timeout sweeper** (on the existing 60 s scheduler tick) fires `timeout.then` when
  `now > expires_at`.

### 7.5 New endpoints / stores

| What | Where | Note |
|---|---|---|
| `POST /connectors/slack/interactive` | `src/api/server.js` | **New.** Slack Block Kit buttons post to the *Interactivity* Request URL, **not** to `/connectors/slack/events` (which exists, at `server.js:1619`). Verify the Slack signature. Register the URL in the Slack app manifest. |
| `GET /approvals/:token` | `src/api/server.js` | Email magic link. Consume → record → resume. Renders a confirmation page (it is a `GET` from a mail client — must be safe to prefetch, so **require a POST confirm** on the landing page rather than mutating on the `GET`). |
| `ApprovalStore` | `src/approvals/approval-store.js` | New. Hashed, single-use, TTL, bound to `(run, node, decision)`. Fail-closed on tenant. |
| Approvals inbox | `src/inbox/` | Exists. Add approval items with Approve/Reject. |

### 7.6 Where approval gates come from

1. **The user asks.** *"Check with me before it sends."*
2. **The gap oracle's default resolution.** Every unresolved gap escalates to a human — which
   **is** a `human` node. This is what makes §6.4's *"Accept all defaults"* safe.
3. **The converger proposes one, unprompted, on high-impact writes.** An irreversible or
   outward-facing action — sending a customer email, posting publicly, creating a record,
   spending money — should trigger: *"This sends a real email to a customer. Want to approve each
   one before it goes out?"* This is a product moment: it is the system demonstrating that it
   understands consequence.

### 7.7 New validator codes

| Code | Rule | Severity |
|---|---|---|
| `HUMAN_WITHOUT_TIMEOUT` | a `human` node **must** declare `timeout` | **error** — a pause with no timeout is a workflow that hangs forever |
| `WEAK_APPROVAL_FOR_WRITE` | a write capability gated by a `medium`-trust channel alone | **error** |
| `APPROVAL_CHANNEL_NOT_CONNECTED` | `channels[].type` not in the tenant's connected catalog | **error** |
| `EMAIL_REPLY_APPROVAL` | `email_reply` used at all | **error** — see §7.2 |

---

## 8. Spec versioning / compatibility

- Executor branches on `spec.version`; **absent ⇒ 1**.
- v1 specs keep running untouched. No migration. (1 live workflow in prod; 13 local.)
- `outcome` is required only when `version === 2`.
- New node types are additive to the registry; a v1 spec simply never uses them.
- **The UI degrades, it does not break.** `choices[]` / `assertionBuilder` are optional fields on
  the interrupt envelope; a client that ignores them still renders the plain composer.

---

## 9. Cost

Build is **$0.2215** today (measured, post-caching v1.3.8). v2 adds turns (outcome + examples +
gaps) and a shape-derivation call.

- Expect **$0.35–0.55/build**. Still 1–2 run-units. Re-derive `BUILD_RUN_COST` from measurement
  when increment C lands; `scripts/checks/tier-caps.mjs` **already fails** if a build is
  under-charged.
- **The UI *lowers* cost.** A click is not an LLM turn. Multiple-choice replaces a
  free-text→parse→re-ask loop with a single structured response — fewer turns, and the ones that
  remain are cheaper because the answer is already normalised.
- **A paused `human` node costs nothing.** It holds no compute. Approvals are free to wait.
- **`foreach` is the new cost risk.** 100 items × a `web_fetch` node ≈ a $20 run. `maxItems` plus
  the per-plan daily USD ceiling (`tenant-guard.js`) are the brakes. **A `foreach` whose body
  contains a web capability must be explicitly bounded in the UI**, not in a config file.

---

## 10. Increments

> One deliverable per session, ending at a gate (CLAUDE.md working rules).
> **Every increment from C on ships its own UI.** The UI is not a phase at the end — a converger
> that asks more without a surface that makes answering cheap is strictly worse than what we
> have today.

### Increment A — validator hardening + node re-cut *(days)* — ✅ **DONE**
**Do this first. It ships value even if everything after is cancelled.**
- Add `UNKNOWN_CONFIG_KEY` — scoped by `configPolicy`, see §5. Plus `REMOVED_NODE_TYPE`,
  `UNKNOWN_LLM_MODE`.
- `llm.mode`; delete `summarize`/`extract`/`rewrite`/`tool`/`mcp-tool`/`fetch`; rename
  `daily-digest` → `assemble` (§2.3); v1 compat shim (`node-types/compat-v1.js`) maps old types →
  `llm`+mode, called from the validator and `FlowTester._runNode` only.
- **Acceptance:** ✅ a spec with `"model":"claude-opus-4-5"` is rejected with
  `UNKNOWN_CONFIG_KEY` (`tests/workflows/validator-config-keys.test.js`). ✅ P2/P3/E2E green
  (E2E **7/7 with `ANTHROPIC_API_KEY` set** — without a key it self-skips the converger test and
  still reports a cheerful "6 pass / 1 skip", where the skipped one is the thing under test).
  ✅ The frozen canonical spec and the prod-shaped `deliver(channel, message, target)` still
  validate.
- **Correction to the acceptance as originally written** — it said *"all 13 local workflows still
  validate"*. There are not 13. `memory/workflows/workflows.sqlite` holds **57 rows, of which 2 are
  not soft-deleted**; the "13" in §1.4 was a count of workflows built through the UI during the
  2026-07-13 measurement, most since deleted. The check that actually protects production is the
  one now in the test: every node/config **shape** that appears anywhere across those 57 specs must
  still validate. That is a superset of the one live prod workflow, and it is what was verified.

### Increment B — engine control flow *(the big engine lift)* — ✅ **DONE**
- Edge liveness (NOT an `active` set — see §4) + `branch` (+ `NON_EXHAUSTIVE_BRANCH`) + `foreach`
  + the `human` durable pause · `on_error` · `idempotency`.
- **Acceptance:** ✅ a spec with a `branch` runs only the selected path and **skips** the other
  (`step_skipped`, not `step_failed`); ✅ a join downstream of both paths still runs; ✅ a spec
  **without** a branch executes byte-identically (asserted on the exact event sequence); ✅ a
  re-fired trigger with `idempotency` does not write twice; ✅ `human` pauses and resumes from the
  **checkpoint** without re-running — or re-paying for — earlier work, and what it delivers is
  byte-identical to what the person approved.
  All in `tests/workflows/control-flow.test.js`. **Every guard is mutation-tested** — the bug is
  re-introduced and a test must fail — because a green suite proved nothing six times running here.
  Do not trust a mutation score quoted in a doc (two were published and both were falsified by an
  independent verifier writing a wider list); re-derive it.

  **`live` and `ruledOut` are load-bearing checkpoint fields, not bookkeeping.** The edge liveness
  is RESTORED from the checkpoint and never re-derived: replaying `propagate()` for an already-done
  node lights ALL of its outgoing edges, while the original leg may have lit only SOME (a `branch`
  lights one case; an `on_error: route_to` lights only the error target). Re-deriving revived the
  ruled-out branch *and* revived the happy path of a step that had FAILED — a declined charge still
  sent the receipt. If you build a `{outputs, skipped, lastOutput}` checkpoint from an older draft
  of this section, you will re-create exactly that bug.
- **Also landed, because the pause is worthless without them:** `workflow_runs.status` gains
  `awaiting_human` (CHECK-constraint rebuild, mirroring the existing `_migrateStatusCheckIfNeeded`
  precedent; 653 production run rows preserved), plus `paused_node` / `pending_ask` columns, and
  `WorkflowScheduler` parks a run on `run_paused` instead of leaving it in `running` forever. It
  also persists `step_skipped` / `step_retry` / `step_routed` for the run history. **The persisted
  steps are NOT the checkpoint** — see the box in §7.4; they are display-shrunk, and resuming from
  them truncated the work product.
- **A `human` node is unreachable by design until Increment D.** The converger does not emit one
  and the builder cannot add one, so no user workflow can park itself waiting for a question
  nobody will ever be asked. D builds the surface that asks it.

### Increment C — converger v2 core + outcome/gap UI *(the moat)* — ✅ **DONE**
- `outcome` + `examples` + `process` + `gaps` graph nodes. **No `decisions` node** — see §3: the
  `decision` node type does not exist until E, so one could only emit an unrunnable spec.
- `gap-scorer.js` rewrite. Spec v2. `UNSATISFIED_ASSERTION`, `MALFORMED_ASSERTION`,
  `MISSING_OUTCOME`, `LLM_INPUT_NOT_ENUM`. New `outcome-oracle.js` (the single satisfaction oracle,
  shared by the validator and the gap scorer) and `decision-analysis.js` (box subtraction).
- **UI:** the shared `choices[]` primitive · outcome cards (`outcome_check`) · the pinned outcome
  card · the gap list (`gap_review`) with **escalate pre-selected** and **Accept all defaults**.
- **Acceptance:** ✅ the "Slack AND email" case (defect #1) **cannot publish** —
  `UNSATISFIED_ASSERTION`, and the live adversarial check proves both destinations survive into the
  contract *at the source*, which is where they were actually being lost. ✅ A 2-node workflow
  ratifies without inventing an LLM node (defect #4). ✅ The converger asks ≥1 exception question
  (defect #5) — every workflow raises at least `NO_ERROR_PATH` ("nothing says what happens if a step
  fails"), which is the one exception question that applies to every workflow ever built and is
  precisely the question v1 had no shape to ask. ✅ Zero-typing: every interrupt carries a
  pre-selected default and *Accept all defaults* is one click.
- **Also landed, because it blocked C:** the `deliver`-node channel-schema fix (see §5) — without
  it no `record_exists` assertion could ever be satisfied by a publishable spec, because every
  Airtable/Sheets delivery failed `UNKNOWN_CONFIG_KEY`.
- **Deferred deliberately, and said so rather than faked:** `assertion.when` is carried but not
  proven (§2.2); the example *picker* (pull three real emails from the inbox) is F; the decision
  TABLE is E.

### Increment D — `human` approval gate + channels + Approvals inbox
- `ApprovalStore` (hashed / single-use / TTL, per §7.3) · durable pause + resume (§7.4) ·
  `POST /connectors/slack/interactive` · `GET /approvals/:token` · timeout sweeper.
- Escalation is the **default** gap resolution — this is what makes Increment C's
  *"Accept all defaults"* honest.
- **UI:** Approvals inbox items with Approve/Reject; Slack Block Kit buttons; the approval email.
- **Acceptance:** an unresolved gap publishes safely and routes to the inbox at runtime. **An
  approval is accepted from Slack and from an email magic link, each recorded with *who* and
  *how*.** A replayed magic link is **rejected** (single-use). A run with no answer hits
  `timeout` and takes the declared path. `email_reply` is rejected by the validator.

### Increment E — `decision` node + table review UI + DMN gap analysis
- Box subtraction, **never** cross-product enumeration (§12).
- **UI:** the decision table (`decision_review`) — dropdown cells over the enum values,
  plain-language hit-policy radio, collapsed by default.
- **Acceptance:** a table with an uncovered enum combination is reported *before* publish;
  `UNIQUE` + overlapping rules is rejected; a decision with **>4 inputs** triggers a decompose
  prompt rather than a table nobody can read.

### Increment F — `foreach` + schema-aware connectors + the example picker
- `airtable_list_bases` · `airtable_describe_table` · `sheets_describe`.
- **UI:** the example picker (`example_request`) — *"pick 3 real emails"* from `gmail_search`;
  destination fields chosen from the **read** schema, never a pasted base ID. This is
  principle §6.2.3 (*never ask for something we can read*) made concrete.
- **Acceptance:** the flagship — *inbound email → extract → decide → Airtable record + Slack* —
  is buildable **by conversation and clicks alone**, with no pasted base ID and no typed example.

### Increment G — test panel as outcome oracle; SOP carries outcome + tables + escalation policy + provenance

---

## 11. Invariants — check before opening a PR

1. **`scripts/gates/p3.sh` is green.** The converger still reproduces the frozen canonical spec
   (`docs/specs/canonical-ups-slack.json`). Structural equivalence + runnability — **never**
   byte-equality; the converger is non-deterministic (CLAUDE.md, 2026-06-12).
2. **A v1 spec executes byte-identically.** No `branch` ⇒ no behaviour change.
3. **`tests/e2e/full-journey.test.js` 7/7.**
4. **`scripts/checks/p11-cross-tenant-adversarial.mjs` passes.**
5. **`scripts/checks/tier-caps.mjs` passes** — if the build got more expensive, `BUILD_RUN_COST`
   must be re-derived.
6. **No spec publishes with an unresolved gap that isn't explicitly escalated.**
7. **No `decision` input has `evaluator:'llm'` without a closed enum.** This is the moat.
8. **No approval is authenticated by parsing an email body.** Signed, hashed, single-use tokens
   only (§7.2, §7.3).
9. **Every interrupt carries a default.** `Enter` must always be a valid answer, and
   *Accept all defaults* must always be reachable.

### New tests
| Layer | What | Where |
|---|---|---|
| Unit | `scoreGap()` over crafted specs: unsatisfied assertion · table gap · UNIQUE overlap · non-exhaustive branch · unknown config key | `tests/converger/gap-oracle.test.js` |
| Unit | Executor: `branch` skips the non-selected subtree; `foreach` bounds at `maxItems`; `human` pauses and **resumes from the checkpoint**, delivering exactly what was approved | `tests/workflows/control-flow.test.js` |
| Unit | **Approvals:** token is stored hashed · single-use (replay rejected) · TTL expiry · approve/reject tokens are distinct and mutually invalidating · timeout takes the declared path | `tests/approvals/approval-store.test.js` |
| Security | **Forged approvals:** unsigned Slack `block_actions` rejected · a token from tenant A cannot resolve a run in tenant B · `email_reply` rejected by the validator | `scripts/checks/approval-adversarial.mjs` |
| Golden | Corpus of `outcome → spec` pairs. Assert **structural** equivalence + gap-freedom. **Never byte-equality.** | `tests/converger/golden/*.json` |
| Adversarial | Extend the `adversary` agent: contradictory outcomes; unstateable outcomes; an outcome needing an absent connector. **It must never silently drop an assertion.** | `scripts/checks/converger-adversarial.mjs` |
| UI | The **zero-typing path**: a build completed entirely through defaults + clicks yields a gap-free, publishable spec | `tests/e2e/zero-typing-build.test.js` |
| Gate | `p12.sh` = p3 green **+** gap-oracle **+** adversarial **+** approval-adversarial **+** the write-shaped E2E | `scripts/gates/p12.sh` |

---

## 12. Open questions (decide before the increment that needs them)

- ~~**FEEL subset**~~ — **ANSWERED.** Adopt DMN's *simple unary tests* subset ("FEEL-A"):
  `-` · literal · `< <= > >=` · intervals `[a..b] (a..b] [a..b) (a..b)` · comma disjunction ·
  `not(...)`. **Exclude variable references (`>= x`)** — their domain is unknown at build time,
  which destroys decidability. No `!=` (FEEL doesn't have it; use `not()`). See
  `bpmn-dmn-foundations.md` §7b(b).
- ~~**Practical table width**~~ — **ANSWERED, measured** (`scripts/checks/gap-analysis-bench.mjs`).
  Compute is a non-issue with **box subtraction**: 10 inputs × 10 values (10¹⁰ combinations)
  analyses in **1 ms**. The binding limit is **cognitive** — at 5+ inputs (1,024+ combinations)
  no human reviews the table, and an unreviewable table is not auditable, which is the moat.
  **DECOMPOSE AT >4 INPUTS.** Implementation directive: box subtraction, never cross-product
  enumeration. See `bpmn-dmn-foundations.md` §7b(a).
- **Decision evaluation cost.** One LLM call for the whole table (cheap, less auditable) vs one
  per fuzzy input (costlier, precisely attributable)? Lean per-input for the audit trail; measure.
- **`foreach` nesting.** Start: **no.** One level.
- **Approval quorum > 1.** Deferred. `quorum: 1` (first responder wins) covers every case we have.
  Two-man rule is a compliance feature to sell *later*, not to build now.
- **`edit` as an approval decision** — *"approve, but change the wording first"*. Very desirable
  for drafted emails; needs a payload-mutation path through the resume. **Increment D+1**, not D.

---

## 13. Why

> **Atlas can tell you what it doesn't know about your process — and won't pretend otherwise.**

Zapier moves records and cannot judge. Camunda can prove completeness and cannot evaluate
"sounds urgent". A pure-LLM builder will hand you a workflow with a hole in it and never mention
the hole.

This is the only design that closes both — and the two things that keep it true are **§11.7**
(the moat: no LLM decision input without a closed enum) and **§6.2.4** (the honesty: every hole
the system finds and cannot fill routes to a human, by default, without the user having to
ask). The completeness proof is what makes the multiple-choice UI possible; the multiple-choice
UI is what makes the completeness proof affordable to the user. They are the same asset.
