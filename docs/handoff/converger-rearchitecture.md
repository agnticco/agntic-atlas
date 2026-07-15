# Converger rearchitecture — clarify-first, generate-whole-spec, wire deterministically

Owner: build session, 2026-07-15. Supersedes the incremental one-component-at-a-time
propose loop. Motivated by the live diagnosis below.

## The diagnosis (why the current converger produces broken, unbranched specs)

The propose loop (`src/converger/elicitation-graph.js:782`) has the model emit **one
component per round** — a single node, edge, or trigger (`prompts.js:174`: *"one component
at a time"*) — over many rounds. The assembler does **no wiring of its own**: `applyProposal`
pushes whatever `edge` proposals the model emits (`spec-assembler.js:85-88`) and de-dupes
nodes only by exact id (`:78-83`). So the ENTIRE graph structure is the model's job to emit,
one edge at a time. Consequences, all observed live:

- **No real branching / orphaned nodes.** The model reliably emits visible **nodes** but
  unreliably emits the invisible **edges**. Live run: it emitted the branch's *output* edges
  (`route_lead→extract`, `route_lead→summarize`) but never `classify→route_lead` (the branch's
  *input*) or `trigger→classify`. So `classify` dangles (zero edges) and the branch has no
  feed — a branch node with no functioning branch.
- **Duplicate deliver nodes.** Node de-dupe is by exact id only; across rounds the model
  re-proposes similar delivers with NEW ids (`create_crm_record`, `deliver_inbox_a2`, three
  `Append lead…`) so they accumulate.
- **"CLARIFICATION" junk node + convoluted feel.** The one-at-a-time loop interleaves proposals
  with clarifications/gaps; unparseable model output falls back to a clarification interrupt
  (`:800-808`). The drip-feed IS the convolution.
- **Auto-repair doesn't save it.** Edge-repair (`gap-scorer.js:201`, #19) hangs off a
  non-blocking `ORPHAN_NODE` warning and did NOT wire `classify→route_lead` in the live run.

## Target architecture

Flip to **clarify-fully-first → generate-the-whole-spec-once → wire deterministically →
present the finished graph**. Keep everything that gathers information or validates the
result; replace only the incremental *building* of structure.

```
  process → (gather: clarify · outcome · examples · destinations)   ← clarify EVERYTHING first
          → generate        ← ONE model call emits the complete {triggers, nodes, edges, cases}
          → wire            ← deterministic assembly: guarantee a connected, branched graph
          → validate/repair ← the validator PROVES structure; repair or re-generate on failure
          → present         ← the finished, correct graph on the canvas for review/approval
          → gaps · decisions · ratify   ← on the COMPLETE spec (unchanged)
```

### The four build changes

1. **`prompts.js` — a whole-spec generation prompt.** Replace "one component at a time" with:
   given the fully-clarified intent + outcome + resolved destinations + capabilities, emit the
   COMPLETE spec — all nodes, ALL edges, and branch `config.cases` — in one structured JSON.
   Teach the branch wiring explicitly: a router is `classify → branch → {each case → its lane}`,
   every node has an inbound edge, every path ends in a delivery, no duplicate delivers. The
   existing per-node-type teaching (llm modes, decision tables, the moat's closed-enum rule)
   carries over verbatim — it's still the vocabulary, just emitted all at once.

2. **`elicitation-graph.js` — `generate` + `wire` nodes replace the `propose` loop.**
   - `generate`: one `llmJson` call → a full draft spec. No per-node interrupt.
   - `wire`: deterministic edge assembly (see spec-assembler below) → guaranteed structure.
   - Restructure `analyze`'s routing so clarify/outcome/examples/destinations run to completion
     FIRST, then `generate` once, then `wire`, then straight to gaps/decisions/ratify.
   - Keep the HITL review as an **approve-the-whole-graph** step (or per-node on the canvas),
     not a per-proposal drip.

3. **`spec-assembler.js` — deterministic wiring (INCREMENT 1, below).** A pure function that,
   given ordered nodes + trigger + each branch/decision node's `cases`, produces the correct
   edge set and de-dupes structurally (not just by id). This is what *guarantees* the graph is
   connected and branched, instead of hoping the model emits every edge.

4. **Validator as the guarantee.** The generated+wired spec still runs through
   `workflow-validator.js`. Structural defects (orphan, unfed branch, non-exhaustive branch,
   duplicate delivery to the same target) must be **caught and repaired or re-generated** before
   `present` — never shown as an "optional gap." (`ORPHAN_NODE` graduates from warning to a
   thing the wire/repair step fixes deterministically.)

## Invariants that MUST survive (do not weaken)

- **The outcome contract** (`outcome{statement,assertions,examples}`) and `complete ⇒
  publishable`. The generated spec is still measured against the outcome; a spec that doesn't
  deliver it doesn't publish.
- **The moat — `LLM_INPUT_NOT_ENUM`** (a branch/decision may route only on a closed, declared
  domain). Whole-spec generation must still obey it; the validator still enforces it.
- **Decision tables, human gates, idempotency, on_error** — all P12 increment semantics.
- **Multi-tenant fail-closed**, capability catalog as the source of truth (no invented ids).

## Increment plan (isolated, testable, each verifiable)

- **INCREMENT 1 — deterministic wiring in `spec-assembler.js` (start here).** Pure function
  `wireEdges(draft)` → returns edges built from structure: `trigger → first node`, sequential
  chain along the node order, `branch/decision → each case.to`, every lane's tail → a delivery.
  De-dupe delivers that target the same channel+destination. Add `tests/converger/wiring.test.js`
  proving: the lead-router wires with NO orphan and a real 2-lane branch; duplicate delivers
  collapse; a missing branch input is added. **No graph/flow changes yet — this is a pure,
  unit-tested function** the `wire` node will call.
- **INCREMENT 2 — the `generate` prompt + node** (whole-spec generation), behind the existing
  graph, feeding `wire`.
- **INCREMENT 3 — restructure `analyze` routing** to clarify-first → generate → wire → gaps.
- **INCREMENT 4 — UI**: the canvas renders the finished spec (mostly built already); the
  approve-the-whole-graph review; retire the pinned-inline drip surface.

Each increment: behavioral tests + the P12 gate suites stay green + headed verification of the
one that lands the user-visible change (3/4).
