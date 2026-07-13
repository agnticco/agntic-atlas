# Converger v2 — outcome-first elicitation, typed shape, provable completeness

**Status:** proposed · **Author:** build session 2026-07-13 · **Supersedes:** nothing (P3 converger stays running until each increment lands)

---

## 0. The thesis, in one page

Today the converger asks *"what would you like to automate?"* — a **process** question — and
then builds forward, one step at a time, until a hardcoded checklist says stop. It never
states a destination, so it cannot know when it has arrived, cannot know what it failed to
capture, and cannot tell you what it does not know.

v2 inverts this:

> **Elicit the outcome. Derive the shape. Fill in the action and the judgment.
> Route what you don't know to a human.**

Three properties fall out, and together they are the moat:

1. **Provable completeness.** A typed decision model has *computable gaps* — input
   combinations no rule covers. The converger stops asking when the model has no holes,
   not when the LLM feels finished.
2. **Safe by construction.** Every uncovered branch defaults to **human escalation**. The
   workflow is complete on day one; the gaps become a backlog the user fills as real
   escalations arrive.
3. **Auditable judgment.** Decisions are captured as reviewable tables (typed inputs →
   rules → output) whose *predicates may be LLM-evaluated*. Camunda has the completeness
   math but cannot evaluate "sounds urgent". Pure-LLM tools can evaluate anything and prove
   nothing. This is the only design that holds both ends.

**Non-goal: a BPMN/DMN port.** We adopt the *semantics* (gateways must be exhaustive;
decision tables must have no gaps), not the *serialization*. The proprietary JSON spec
stays — see CLAUDE.md, "closed decisions". Emitting BPMN XML wins us nothing commercially
and drags in a 500-page spec surface.

---

## 1. What is actually wrong today (evidence, not opinion)

Measured during the 2026-07-13 stress test (13 workflows built through the real UI).

| # | Defect | Root cause | Evidence |
|---|---|---|---|
| 1 | Converger **silently drops a requested step** | Nothing declares what the finished workflow must produce, so nothing notices an omission | Asked for a note to Slack **and** email, confirmed twice; published spec had only `deliver_slack`. |
| 2 | `timeMin: "{{today}}"` sent to Google Calendar → **400** | Node config is not type-checked; `{{today}}` is not a real template var (`_node-input.js` supports `{{prev}}`, `{{nodeId.output}}`, `{{date}}`, `{{time}}`) | `fetch_calendar` node config, run failed at execution time in production. |
| 3 | Dead `"model":"claude-opus-4-5"` field on LLM nodes | Converger invents config keys; executor silently ignores unknown keys | `src/workflows/node-types/llm.js` never reads `config.model`. |
| 4 | **Cannot tell a 2-node workflow is finished** | `scoreGap()` is a hardcoded checklist requiring trigger + *processing* + delivery | `src/converger/gap-scorer.js:12-41`. It demanded a "processing step" for a static Slack post, so the converger **invented an LLM node** to satisfy it. |
| 5 | **Zero exception questions asked**, ever | There is no shape model to interrogate; no notion of a branch, a failure path, or an uncovered case | 13 builds; not one question about what happens if a step fails or an input is missing. |
| 6 | Airtable not conversationally reachable | No `list_bases` / schema-read capability, so the user must paste an opaque base ID | Blocks the highest-value (write-shaped) workflows. |

Defects 1–3 are all the same disease: **the converger invents structure that nothing
validates.** Defects 4–5 are the same disease: **there is no model of "done".**

### The engine's own limits (these bound what the converger can even express)

- `src/workflows/flow-tester.js:66,108` — Kahn topological sort, then **every node runs.**
  There is **no conditional execution**. A `branch` is currently inexpressible.
- No iteration. "10 inbound emails → 10 records" cannot be expressed.
- No durable human pause at *workflow* runtime. (The converger has `interrupt()`, the
  executor does not.)
- `summarize` / `extract` / `rewrite` are separate node types that are all "an LLM call with
  a different prompt" — they inflate the vocabulary the converger reasons over and buy no
  expressiveness.

---

## 2. Target architecture

### 2.1 The spec, v2

`spec.outcome` is new and is the anchor. Everything else is derived from or checked against it.

```jsonc
{
  "version": 2,
  "name": "Inbound lead capture",

  // NEW — the contract. What must be true when this is done.
  "outcome": {
    "statement": "Every inbound sales email produces a Leads record with Name, Company, Budget and Priority; anything over $50k also pings #sales-urgent.",
    "assertions": [                       // machine-checkable; drives the test oracle
      { "id": "a1", "kind": "record_exists",  "target": "airtable:Leads",
        "fields": ["Name", "Company", "Budget", "Priority"] },
      { "id": "a2", "kind": "message_sent",   "target": "slack:#sales-urgent",
        "when": "budget_gt_50k" }         // references a branch id
    ]
  },

  "triggers": [ { "type": "email", "filter": "..." } ],

  "nodes": [
    { "id": "extract_fields", "type": "llm", "mode": "extract",
      "config": { "fields": ["name","company","budget"] } },

    // NEW — typed decision. Reviewable. Cells may be LLM-evaluated.
    { "id": "score_priority", "type": "decision",
      "inputs":  [ { "key": "budget",    "type": "number" },
                   { "key": "tone",      "type": "enum",   "values": ["calm","urgent"],
                     "evaluator": "llm" } ],   // ← fuzzy predicate, LLM-judged
      "output":  { "key": "priority", "type": "enum", "values": ["P1","P2","P3"] },
      "hitPolicy": "FIRST",
      "rules": [
        { "when": { "budget": ">50000" },                  "then": "P1" },
        { "when": { "tone": "urgent" },                    "then": "P1" },
        { "when": { "budget": "10000..50000" },            "then": "P2" },
        { "when": {},                                      "then": "P3" }   // catch-all
      ]
    },

    // NEW — conditional gateway. MUST be exhaustive.
    { "id": "budget_gt_50k", "type": "branch",
      "on": "budget",
      "cases": [
        { "when": ">50000", "to": "ping_sales" },
        { "when": "*",      "to": "create_record" }   // catch-all is mandatory
      ] },

    { "id": "create_record", "type": "connector-action",
      "config": { "action": "airtable_create_record", "baseId": "...", "table": "Leads",
                  "fields": { "Name": "{{extract_fields.name}}", "Priority": "{{score_priority.output}}" } },
      "idempotency": { "key": "{{extract_fields.email}}", "on_conflict": "update" },  // NEW
      "on_error": { "retry": 2, "then": "escalate" } },                                // NEW

    { "id": "ping_sales", "type": "connector-action",
      "config": { "action": "slack_post", "target": "#sales-urgent" } },

    // NEW — the landing zone for everything we don't know.
    { "id": "human_review", "type": "human",
      "config": { "assignee": "inbox", "prompt": "Budget could not be determined — set it?" } }
  ],

  "edges": [ /* ... */ ],

  // NEW — audit trail of elicitation. Feeds the SOP.
  "provenance": [
    { "assertion": "a1", "source": "user", "turn": 3, "quote": "...every lead ends up in Airtable" },
    { "gap": "budget_unknown", "resolution": "escalate", "default": true }
  ]
}
```

### 2.2 Node library — re-cut, not ballooned

Two axes, opposite strategies. **The work axis is already solved** — `connector-action` +
`CapabilityRegistry` means a new connector is a config edit, not a node type. Do not touch it.

| | Today | v2 |
|---|---|---|
| **Work (open)** | `connector-action`, `llm`, `summarize`, `extract`, `rewrite`, `search-web`, `deliver`, `daily-digest` | `connector-action` (unchanged) · `llm` with `mode: summarize\|extract\|rewrite\|classify\|freeform` · `deliver` |
| **Control (new, closed)** | — | **`branch`** · **`decision`** · **`foreach`** · **`human`** · **`wait`** |
| **Attributes (new)** | — | `on_error: { retry, then: escalate\|route_to }` · `idempotency: { key, on_conflict }` — on *any* node |
| **Delete** | `tool`, `mcp-tool`, `fetch` (dead — no `ToolRegistry`; see CLAUDE.md gotchas), `daily-digest` (a preset) | — |

**Net node-type count barely moves.** We collapse three prompt-presets-masquerading-as-types
into `llm.mode`, delete three dead types, and add five control primitives. Expressiveness goes
from "straight line" to the full BPMN core.

> **Hard rule: the converger composes from this closed vocabulary. It never defines new node
> types.** Free-form node shapes would make gap analysis, overlap detection, and
> "you declared an output that isn't wired" *impossible* — i.e. they would delete the moat.
> Defects 1–3 above are what a *partially* open grammar already costs us.

---

## 3. Engine changes (`src/workflows/`)

This is the largest block of work and it gates everything else.

### 3.1 Conditional execution — `flow-tester.js` / executor
Today: topo-sort, run every node. Needed: a node may be **skipped** because a branch did not
select it.

- Add an `active` set to the run context. A `branch` node evaluates its `on` input, picks
  exactly one `case`, and marks the non-selected subtrees inactive.
- A node whose *every* parent is inactive is skipped (status `skipped`, not `error`).
- **`branch` must be exhaustive**: a `*` catch-all case is mandatory (validator-enforced,
  §5). This is the BPMN gateway rule, and it is what makes "what if not?" un-skippable.

### 3.2 Iteration — `foreach`
- `foreach` declares `over` (a collection expression) and a `body` (a sub-graph id).
- The executor runs the body once per item, with `{{item}}` bound; outputs collect into an array.
- **Bounded**: `maxItems` (default 100) — a runaway `foreach` is a cost incident. This
  interacts with the run meter: see §9.

### 3.3 Durable human pause — `human`
The converger already has `interrupt()` in the agent core; the **executor does not**.

- New run status `awaiting_human` on `workflow_runs`.
- The run persists at the pause point; the scheduler does not re-fire it.
- Resume via a new endpoint + an **Approvals inbox** (reuse the existing Inbox surface —
  `src/inbox/`, already delivering to the sidebar with an unread badge).
- **Every uncovered branch and every `on_error: escalate` lands here.** This is the safety
  net that makes "complete by construction" true rather than aspirational.

### 3.4 Error / idempotency attributes
- `on_error: { retry: N, then: 'escalate' | 'route_to:<nodeId>' }` on any node.
  (Workflow-level retry already exists in `workflow-scheduler.js`; this is *per node* and
  can escalate to a human instead of failing the run.)
- `idempotency: { key, on_conflict: 'skip'|'update'|'error' }` on write nodes. **Without this
  the write story is unsellable** — a re-fired trigger silently duplicating CRM records is
  the fastest way to get uninstalled.

### 3.5 Schema-aware connectors (unblocks the write story)
`connector-action` capabilities gain an optional `describe()` returning the *target's* schema
(Airtable base tables + field names/types; Sheets header row; etc.).

- New capabilities: `airtable_list_bases`, `airtable_describe_table`, `sheets_describe`.
- The converger reads the schema and maps `"the customer's budget"` → the `Deal Size` column
  **itself**. Today the user must paste an opaque base ID — which is exactly where the
  "just talk to it" promise dies.

---

## 4. Converger changes (`src/converger/`)

### 4.1 Graph: three phases, replacing the current single loop
Current graph (`elicitation-graph.js:114-291`): `analyze → (clarify | propose) → analyze → ratify`.

New graph:

```
intent
  → OUTCOME     (elicit the contract; loop until assertions are testable)
  → SHAPE       (derive the graph by backward-chaining from assertions; no user turns)
  → FILL        (elicit rules/prompts/mappings per node; gap analysis loop)
  → RATIFY      (confirm; emit spec v2)
```

- **`outcome` node (new).** Asks the question we never ask: *"How would we know this worked?
  What would be true afterwards that isn't true now?"* Loops until every assertion is
  machine-checkable (has a `kind`, a `target`, and a field/condition contract). This is the
  hardest and most valuable node in the product; it is the interview a consultant charges for.
- **`shape` node (new, mostly non-interactive).** Backward-chains from the assertions:

  | the outcome demands | derived node |
  |---|---|
  | a record exists with fields F | terminal `connector-action` write, config schema declares F |
  | F not present in the source | `llm mode:extract` |
  | a field requires a judgment | **`decision`** |
  | "…and if X also Y" | **`branch`** (+ second terminal) |
  | "every X" | **`foreach`** |
  | data must come from somewhere | source `connector-action` / trigger |

  The shape is *derived*, not guessed. This is the core algorithmic change.
- **`fill` node.** Per node, elicits content (rules, prompt text, field mapping, thresholds).
  Runs **gap analysis** after each turn; asks *targeted* questions about uncovered cases.
- **`ratify`** — largely as today, but now confirming outcome + shape + decisions + gaps.

### 4.2 `gap-scorer.js` — rewrite (this is the heart)
Delete the 5-item checklist. Replace with a real oracle over three gap classes:

1. **Outcome gaps** — an assertion with no node that satisfies it.
   *(Kills defect #1: "Slack AND email" = two assertions; a spec with one terminal fails.)*
2. **Coverage gaps** — a `decision` table with input combinations no rule matches
   (enumerable inputs only), or a `branch` with no catch-all.
   *(Kills defect #5: the exception questions become derivable.)*
3. **Contract gaps** — a required config field with no value; a template var that does not
   exist; a write node with no `idempotency`; a node with no `on_error`.
   *(Kills defects #2 and #3.)*

Every gap has a **default resolution: escalate to human.** `scoreGap()` returns
`{ gaps: [...], complete: boolean }` where `complete` means *"every gap is either answered or
explicitly escalated"* — never *"we stopped asking."*

> **Honest limit:** gap analysis is only computable over **enumerable** input domains
> (`enum`, numeric ranges, booleans). `tone: "urgent"` has no finite domain — for
> LLM-evaluated inputs we can only check that a catch-all exists. Say this out loud in the
> UI; do not imply a completeness proof we cannot make.

### 4.3 `prompts.js`, `spec-assembler.js`
- `buildOutcomePrompt()` (new), `buildShapePrompt()` (new), `buildFillPrompt()` (replaces
  `buildProposePrompt`).
- `assembleSpec()` emits `version: 2` + `outcome` + `provenance`.
- **The system prompt must enumerate the closed node vocabulary and the exact template vars.**
  Defects #2/#3 exist because it doesn't.

---

## 5. Validator (`src/workflows/workflow-validator.js`)

New error codes. Each one is a bug from §1 that becomes impossible to ship:

| Code | Rule | Kills |
|---|---|---|
| `UNSATISFIED_ASSERTION` | every `outcome.assertions[]` maps to ≥1 node that satisfies it | #1 (dropped step) |
| `UNKNOWN_TEMPLATE_VAR` | every `{{...}}` resolves against `_node-input.js`'s grammar | #2 (`{{today}}` → 400) |
| `UNKNOWN_CONFIG_KEY` | node config keys ⊆ the type's `configSchema` | #3 (dead `model` field) |
| `NON_EXHAUSTIVE_BRANCH` | every `branch` has a `*` catch-all | #5 |
| `DECISION_TABLE_GAP` | enumerable inputs fully covered, or catch-all present | #5 |
| `WRITE_WITHOUT_IDEMPOTENCY` | *warning* on write capabilities lacking `idempotency` | duplicate-record risk |

`UNKNOWN_CONFIG_KEY` is the single highest-leverage check in the list: it converts "the
converger hallucinated a field" from a silent production failure into a build-time error.

---

## 6. UI (`public/index.html`)

The builder already has the right *bones* — the confirm-each-step signal line and the test
panel are the best things in the product. v2 adds four surfaces:

1. **Outcome card** (top of the build pane, above the steps). The agreed contract, in the
   user's own words, pinned. Editable. This is the thing they sign off on.
2. **Decision table review.** A `decision` node renders as a *table*, not prose. Reviewable
   and signable — this is the artifact that a compliance buyer needs and a pure-LLM
   competitor structurally cannot produce.
3. **Gap list** — *"You haven't told me what to do in these 3 cases."* Each row: **Answer** ·
   **Escalate to me** (the default) · **Ignore**. This is the visible manifestation of the
   moat: the system telling you what it doesn't know.
4. **Approvals inbox** — where escalations land at runtime. Reuse `src/inbox/`.

**Test panel becomes the outcome oracle.** Today it asks *"does this look right?"*. With
assertions it asserts: *a Leads record exists with 4 fields; #sales-urgent received a message.*
Pass/fail against the contract — not vibes. This is a strict upgrade to the single most
persuasive moment in the demo.

**SOP export becomes the signed spec.** `sop-generator.js` / `sop-pdf.js` gain: outcome +
decision tables + escalation policy + `provenance`. That is the consultant's deliverable, and
it is what Sarah's replacement reads.

---

## 7. Test suite & gates

Current converger gate: `scripts/gates/p3.sh` → `scripts/checks/p3-converger-run.mjs`,
which asserts the converger reproduces the frozen canonical spec
(`docs/specs/canonical-ups-slack.json`). **It must keep passing throughout** — it is the
non-regression floor.

New:

| Layer | What | Where |
|---|---|---|
| **Unit** | `scoreGap()` over crafted specs: unsatisfied assertion, table gap, non-exhaustive branch, unknown template var, unknown config key | `tests/converger/gap-oracle.test.js` |
| **Unit** | Executor: branch skips the non-selected subtree; `foreach` bounds at `maxItems`; `human` pauses and resumes | `tests/workflows/control-flow.test.js` |
| **Golden** | A **corpus of outcome→spec pairs**. Assert *structural* equivalence + gap-freedom, **never** byte-equality — the converger is non-deterministic (see CLAUDE.md, P3 "exact" decision, 2026-06-12) | `tests/converger/golden/*.json` |
| **Adversarial** | The `adversary` agent, extended: feed contradictory outcomes, unstateable outcomes, outcomes needing an impossible connector. **It must not silently drop an assertion** — that is the regression we most fear | `scripts/checks/converger-adversarial.mjs` |
| **E2E** | Build the write-shaped flagship (email → extract → decide → Airtable + Slack) through the real UI; assert the record exists and the message was sent | extend `tests/e2e/full-journey.test.js` |
| **Gate** | `scripts/gates/p12.sh`: p3 still green **+** gap-oracle unit **+** adversarial **+** the write-shaped E2E | `scripts/gates/p12.sh` |

**Gate P12 fails closed**, per the constitution. And a new invariant worth a check of its own:
*no spec may publish with an unresolved gap that isn't explicitly escalated.*

---

## 8. Migration & compatibility

- **v1 specs keep running.** The executor branches on `spec.version`; absent = 1. No migration
  of live workflows. (13 exist in the local corpus; 1 in prod.)
- `outcome` is **optional** on v1, **required** on v2. The validator only enforces
  `UNSATISFIED_ASSERTION` when `version === 2`.
- New node types are additive to the registry — a v1 spec simply never uses them.
- **The converger emits v2 from day one of increment C**; existing published workflows are
  untouched until the user edits them.

---

## 9. Cost impact

Post-caching, a build is **$0.2215** (measured, v1.3.8). v2 adds turns (outcome elicitation +
gap questions) and a shape-derivation call.

- Estimated build cost: **$0.35–0.55** — i.e. back to roughly the *pre-caching* price, for a
  dramatically better artifact. Still ~1–2 run-units.
- **Charge it honestly**: `BUILD_RUN_COST` (currently 1) should be re-derived from measurement
  once increment C lands, and `scripts/checks/tier-caps.mjs` will fail if a build is
  under-charged (it already asserts this).
- **`foreach` is the new cost risk.** A 100-item `foreach` over a web_fetch node is a
  $20 run. `maxItems` (default 100) plus the per-plan daily USD ceiling
  (`tenant-guard.js`) are the two brakes. **A `foreach` whose body contains a web capability
  must be explicitly bounded by the user** — surface it in the UI, not in a config file.

---

## 10. Sequencing — each increment ships value on its own

> Constitution: one deliverable per session, ending at a gate; close a phase before starting
> the next (`docs/COMMIT_CONVENTION.md`, CLAUDE.md working rules).

| Inc | Deliverable | Ships value even if we stop here | Depends on |
|---|---|---|---|
| **A** | **Validator hardening**: `UNKNOWN_CONFIG_KEY`, `UNKNOWN_TEMPLATE_VAR`. Node-library re-cut (`llm.mode`; delete `tool`/`mcp-tool`/`fetch`/`daily-digest`). | Kills defects #2 and #3 outright. Days, not weeks. **Do this first.** | — |
| **B** | **Engine control flow**: `branch` (+ exhaustiveness), `on_error`, `idempotency`. Executor `active`-set. | Conditionals + safe writes. Unblocks the whole write story. | A |
| **C** | **Converger v2 core**: outcome node, shape derivation, gap oracle, spec v2, `UNSATISFIED_ASSERTION`. Outcome card + gap list in UI. | **The moat.** Defects #1, #4, #5 die here. | A, B |
| **D** | **`human` + Approvals inbox**; escalation as the default gap resolution. | "Safe by construction" becomes true rather than a slogan. | B, C |
| **E** | **`decision` node + table review UI**; DMN gap analysis over enumerable inputs. | The auditable, signable artifact — the enterprise unlock. | C |
| **F** | **`foreach` + schema-aware connectors** (`airtable_list_bases`, `describe_table`). | The write-shaped flagship becomes buildable **by conversation alone**. | B, C |
| **G** | Test panel as outcome oracle; SOP export carries outcome + tables + provenance. | The demo and the deliverable. | C, E |

A is a few days. B–C is the bulk. D–G are each independently shippable.

---

## 11. Risks, honestly

1. **Re-introducing the interrogation.** We just made elicitation *cheap* (4 minutes). A
   rigorous gap interview could become a 40-question slog and destroy the thing that beats a
   consultant. **Mitigation:** build the happy path in one pass exactly as today; surface gaps
   *afterwards* as a reviewable list with **escalate-to-human as the pre-selected default**.
   The user answers zero questions if they don't want to.
2. **Users can't state outcomes either.** *"I want my inbox under control"* is a wish, not a
   contract. Phase 1 needs its own elicitation and it is genuinely hard. **This is the
   highest-risk node in the design** — and also the most defensible, because it isn't a prompt
   trick, it's the interview.
3. **Fuzzy inputs break the completeness proof.** We can only compute gaps over enumerable
   domains. **Do not oversell.** The UI must distinguish "provably covered" from
   "catch-all present".
4. **Executor blast radius.** `flow-tester.js` is described in CLAUDE.md as the best-built part
   of the codebase. Conditional execution touches its core. **Mitigation:** `active`-set is
   additive; a spec with no `branch` executes byte-identically to today. Gate on P2/P3
   non-regression.
5. **Scope.** This is a multi-week program, not a sprint. Increment A alone repays itself.

---

## 12. Open questions

- Does `decision` evaluate as **one LLM call over the whole table** (cheap, less auditable) or
  **one call per fuzzy predicate** (costly, precisely attributable)? Lean per-predicate for
  auditability; measure.
- Where does `provenance` live — in the spec (portable, bloats it) or in
  `interaction-store.js` (already stores the elicitation transcript)? Lean on the store, with
  a reference from the spec.
- `foreach` over a `branch` — do we allow nesting? Start: **no.** One level, revisit later.
- Should the outcome contract be *editable after publish*, and does editing it force
  re-derivation of the shape? Probably yes, and yes — but that is a v2.1 question.

---

## 13. What this is really for

Every one of the three headline properties exists to support one sentence, which is the thing
no competitor can say:

> **Atlas can tell you what it doesn't know about your process — and won't pretend otherwise.**

Zapier moves records and cannot judge. Camunda can prove completeness and cannot evaluate
"sounds urgent". A pure-LLM builder will confidently hand you a workflow with a hole in it and
never mention the hole. This design is the only one that closes both.
