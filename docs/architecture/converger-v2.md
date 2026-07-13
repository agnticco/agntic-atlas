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
- **§3–§8 are the deltas**, file by file, with before/after signatures.
- **§9 sequences the work** into increments. Each has explicit **acceptance criteria** and a
  gate. Do one increment per session, end at its gate.
- **§10 is the list of things that must not break.** Check it before you open a PR.

**Anchors are exported symbol names, not line numbers.** Per CLAUDE.md, line numbers in a brief
are non-authoritative provenance — re-ground against the symbol.

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
| 3 | Dead `"model":"claude-opus-4-5"` on LLM nodes | Config keys are not checked against `configSchema` |
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

### 2.3 Node library — re-cut, not ballooned

| | Today | v2 |
|---|---|---|
| **Work (open axis)** | `connector-action`, `llm`, `summarize`, `extract`, `rewrite`, `search-web`, `deliver`, `daily-digest` | `connector-action` *(unchanged — this is the open axis; **do not touch**)*<br>`llm` **+ `mode: summarize\|extract\|rewrite\|classify\|freeform`**<br>`deliver` |
| **Control (new, closed)** | — | **`decision`** · **`branch`** · **`foreach`** · **`human`** · **`wait`** |
| **Attributes (any node)** | — | `on_error: { retry, then: 'escalate'\|'route_to:<id>' }`<br>`idempotency: { key, on_conflict: 'skip'\|'update'\|'error' }` |
| **Delete** | — | `tool`, `mcp-tool`, `fetch` *(dead — no ToolRegistry)*, `daily-digest` *(a preset)* |

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

### `gap-scorer.js` → **rewrite** (this is the heart)

```js
// BEFORE
scoreGap(draft) → { needsTrigger, needsProcessing, needsDelivery, needsEdges, needsName, complete }

// AFTER
scoreGap(spec, { capabilities }) → {
  gaps: [ {
    id, class: 'outcome'|'coverage'|'contract',
    nodeId, message,
    resolution: 'unanswered' | 'answered' | 'escalated',   // default → 'escalated'
    decidable: boolean          // false when the domain is infinite (say so in the UI)
  } ],
  complete: boolean             // every gap answered OR explicitly escalated
}
```

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

### `elicitation-graph.js` → new nodes
```
outcome   (new, interactive)   → loops until every assertion is machine-checkable
examples  (new, interactive)   → asks for 3 concrete cases; induces rules from them
decisions (new, mostly LLM)    → builds tables from examples; runs gap analysis; asks hit policy
process   (new, non-interactive) → backward-chains the graph from assertions
gaps      (new, interactive)   → presents the gap list; default resolution = escalate
ratify    (existing)           → confirm; emit spec v2
```
Keep `analyze`/`clarify`/`propose` for the v1 path until increment C is green (see §9).

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

### `flow-tester.js` — conditional execution
Today: topo-sort → run every node. Needed: a node may be **skipped**.

- Add an `active: Set<nodeId>` to the run context. Initially all nodes.
- `branch` evaluates `on`, selects exactly **one** case, and marks the subtrees of the
  non-selected cases inactive.
- A node whose parents are **all** inactive → status `skipped` (**not** `error`).
- **A spec with no `branch`/`foreach`/`human` must execute byte-identically to today.** This is
  the non-regression contract; P2/P3 prove it.

### New node types (`src/workflows/node-types/`)
| Type | `run(cfg, ctx, services)` behaviour |
|---|---|
| `decision` | Evaluate `inputs` (LLM inputs = **classify into the declared enum**, one call per fuzzy input for auditability), match `rules` under `hitPolicy`, return the output value. Emit which rule fired → audit trail. |
| `branch` | Evaluate `on`; select one `case`; deactivate the rest. |
| `foreach` | Iterate `over` a collection, binding `{{item}}`; collect outputs. **`maxItems` (default 100)** — a runaway `foreach` over a web node is a cost incident. |
| `human` | **Durable pause.** New run status `awaiting_human`; persist; resume via the Approvals inbox (reuse `src/inbox/`). |
| `wait` | Timer. |

### `llm.js` — add `mode`
`mode: summarize | extract | rewrite | classify | freeform`. Then **delete** `summarize.js`,
`extract.js`, `rewrite.js`, `daily-digest.js`, `tool.js`, `mcp-tool.js`, `fetch.js`, and remove
them from `node-types/index.js`. Map the old types → `llm` + mode in a v1 compat shim.

### Schema-aware connectors (unblocks the write story)
New capabilities: `airtable_list_bases`, `airtable_describe_table`, `sheets_describe`.
The converger reads the destination's field names and maps *"the customer's budget"* → the
`Deal Size` column **itself**. Today the user must paste an opaque base ID — which is precisely
where "just talk to it" dies.

---

## 5. DELTA: `workflow-validator.js`

| New code | Rule | Kills |
|---|---|---|
| `UNSATISFIED_ASSERTION` | every `outcome.assertions[]` maps to ≥1 node that satisfies it | **#1** |
| `UNKNOWN_CONFIG_KEY` | node config keys ⊆ the type's `configSchema` | **#3** |
| `LLM_INPUT_NOT_ENUM` | a `decision` input with `evaluator:'llm'` **must** be `type:'enum'` with `values` | **protects the moat** |
| `NON_EXHAUSTIVE_BRANCH` | every `branch` has a `*` case | **#5** |
| `DECISION_TABLE_GAP` | enumerable inputs fully covered, or a catch-all rule exists | **#5** |
| `UNIQUE_HIT_OVERLAP` | `hitPolicy: UNIQUE` but rules overlap | **#5** |
| `WRITE_WITHOUT_IDEMPOTENCY` | **warning** on write capabilities lacking `idempotency` | duplicate records |

`UNKNOWN_CONFIG_KEY` is the highest-leverage check: it turns "the converger hallucinated a
field" from a silent production failure into a build-time error.

---

## 6. DELTA: API + UI

- `POST /api/builder/sessions/:threadId/respond` — accept the new interrupt payloads (§2.5).
- `public/index.html` — the switch on `iv.type` (currently `done|clarification|proposal|ratify`)
  gains `outcome_check | example_request | decision_review | gap_review`.

New surfaces:
1. **Outcome card** — pinned above the steps. The contract, in the user's words. Editable.
2. **Decision table review** — a `decision` renders as a **table**, not prose. *This is the
   artifact a compliance buyer signs and a pure-LLM competitor cannot produce.*
3. **Gap list** — *"You haven't told me what to do in these 3 cases."* Each row:
   **Answer** · **Escalate to me** *(pre-selected default)* · **Ignore**.
4. **Approvals inbox** — where escalations land at runtime (`src/inbox/`).

**Test panel becomes the outcome oracle.** It stops asking *"does this look right?"* and starts
asserting the `outcome.examples` — pass/fail against the contract. This is a strict upgrade to
the single most persuasive moment in the demo.

**SOP export** (`sop-generator.js`, `sop-pdf.js`) gains outcome + decision tables + escalation
policy + provenance. That is the consultant's deliverable.

---

## 7. Spec versioning / compatibility

- Executor branches on `spec.version`; **absent ⇒ 1**.
- v1 specs keep running untouched. No migration. (1 live workflow in prod; 13 local.)
- `outcome` is required only when `version === 2`.
- New node types are additive to the registry; a v1 spec simply never uses them.

---

## 8. Cost

Build is **$0.2215** today (measured, post-caching v1.3.8). v2 adds turns (outcome + examples +
gaps) and a shape-derivation call.

- Expect **$0.35–0.55/build**. Still 1–2 run-units. Re-derive `BUILD_RUN_COST` from measurement
  when increment C lands; `scripts/checks/tier-caps.mjs` **already fails** if a build is
  under-charged.
- **`foreach` is the new cost risk.** 100 items × a `web_fetch` node ≈ a $20 run. `maxItems`
  plus the per-plan daily USD ceiling (`tenant-guard.js`) are the brakes. **A `foreach` whose
  body contains a web capability must be explicitly bounded in the UI**, not in a config file.

---

## 9. Increments

> One deliverable per session, ending at a gate (CLAUDE.md working rules).

### Increment A — validator hardening + node re-cut *(days)*
**Do this first. It ships value even if everything after is cancelled.**
- Add `UNKNOWN_CONFIG_KEY`.
- `llm.mode`; delete `summarize`/`extract`/`rewrite`/`daily-digest`/`tool`/`mcp-tool`/`fetch`;
  v1 compat shim maps old types → `llm`+mode.
- **Acceptance:** the exact 2026-07-13 spec with `"model":"claude-opus-4-5"` is rejected with
  `UNKNOWN_CONFIG_KEY`. P2/P3/E2E green. All 13 local workflows still validate.

### Increment B — engine control flow *(the big engine lift)*
- `active`-set + `branch` (+ exhaustiveness) · `on_error` · `idempotency`.
- **Acceptance:** a spec with a `branch` runs only the selected path; a spec **without** one
  executes byte-identically to today (P2/P3 prove it); a re-fired trigger with `idempotency`
  does not duplicate a record.

### Increment C — converger v2 core *(the moat)*
- `outcome` + `examples` + `decisions` + `process` + `gaps` graph nodes.
- `gap-scorer.js` rewrite. Spec v2. `UNSATISFIED_ASSERTION`, `LLM_INPUT_NOT_ENUM`.
- Outcome card + gap list in the UI.
- **Acceptance:** the "Slack AND email" case (defect #1) **cannot publish** — it fails
  `UNSATISFIED_ASSERTION`. A 2-node workflow ratifies without inventing an LLM node
  (defect #4). The converger asks ≥1 exception question (defect #5).

### Increment D — `human` + Approvals inbox
- Durable pause; escalation as the **default** gap resolution.
- **Acceptance:** an unresolved gap publishes safely and routes to the inbox at runtime.

### Increment E — `decision` node + table review UI + DMN gap analysis
- **Acceptance:** a table with an uncovered enum combination is reported *before* publish;
  `UNIQUE` + overlapping rules is rejected.

### Increment F — `foreach` + schema-aware connectors
- **Acceptance:** the flagship — *inbound email → extract → decide → Airtable record + Slack* —
  is buildable **by conversation alone**, with no pasted base ID.

### Increment G — test panel as outcome oracle; SOP carries outcome + tables + provenance

---

## 10. Invariants — check before opening a PR

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

### New tests
| Layer | What | Where |
|---|---|---|
| Unit | `scoreGap()` over crafted specs: unsatisfied assertion · table gap · UNIQUE overlap · non-exhaustive branch · unknown config key | `tests/converger/gap-oracle.test.js` |
| Unit | Executor: `branch` skips the non-selected subtree; `foreach` bounds at `maxItems`; `human` pauses/resumes | `tests/workflows/control-flow.test.js` |
| Golden | Corpus of `outcome → spec` pairs. Assert **structural** equivalence + gap-freedom. **Never byte-equality.** | `tests/converger/golden/*.json` |
| Adversarial | Extend the `adversary` agent: contradictory outcomes; unstateable outcomes; an outcome needing an absent connector. **It must never silently drop an assertion.** | `scripts/checks/converger-adversarial.mjs` |
| Gate | `p12.sh` = p3 green **+** gap-oracle **+** adversarial **+** the write-shaped E2E | `scripts/gates/p12.sh` |

---

## 11. Open questions (decide before the increment that needs them)

- **FEEL subset.** DMN's expression language already gives `>50000`, `[10000..50000]`, `-` with
  battle-tested semantics. Adopt a constrained subset rather than invent one. **Blocks E.**
- **Decision evaluation cost.** One LLM call for the whole table (cheap, less auditable) vs one
  per fuzzy input (costlier, precisely attributable)? Lean per-input for the audit trail; measure.
- **Practical table width.** Gap analysis is exponential in input count. Where does it become
  unusable — 5 inputs? 7? This determines when the converger must **decompose** a decision into
  sub-decisions (a DRG) rather than widen it. **Needs measurement, not a guess. Blocks E.**
- **`foreach` nesting.** Start: **no.** One level.

---

## 12. Why

> **Atlas can tell you what it doesn't know about your process — and won't pretend otherwise.**

Zapier moves records and cannot judge. Camunda can prove completeness and cannot evaluate
"sounds urgent". A pure-LLM builder will hand you a workflow with a hole in it and never mention
the hole. This is the only design that closes both — and §10.7 is the line that keeps it true.
