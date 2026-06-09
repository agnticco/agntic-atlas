# Agntic Ops — Gap Map & Pilot Build Plan

A single handoff document for a build session. Part 1 is the audit verdict: what
exists, what's missing, and the two load-bearing gaps. Part 2 is the sequenced
build plan that closes those gaps for the Innovation Depot pilot.

**Scope decisions baked into this plan:**

- **All UI is built fresh.** No existing frontend is reused; no re-wiring of the
  dormant in-chat builder. This is a deliberate call — see the note under Part 2.
- **No white-labeling / per-business tenancy in pilot scope.** Parked until a
  second customer exists.
- **No BPMN/DMN port.** The engine's existing JSON spec format is kept.

---

## Part 1 — Gap Map

### Headline verdict

There is a **strong conversational-AI platform with a real, running workflow
execution engine** — and the codebase is **missing the one feature the product is
named after**: the conversational *elicitation engine* that converges on a spec
through dialogue. Today, workflows get built two ways: a one-shot CRUD tool (the
agent gathers everything, then makes a single `create_workflow` call) and a
deterministic 6-step form wizard. Neither is the "propose one step → user confirms
→ measure the gap to a complete spec → repeat" loop the product requires.

The expensive, hard-to-get-right parts — the DAG executor, the MCP runtime,
credential encryption, auth — are done and solid. The build ahead is the layer
that *feeds and surfaces* that engine, not the engine itself.

### What's genuinely solid (don't touch)

- **Agent core** — compiled `StateGraph` with a ReAct tool loop and two-phase
  parallel planning (plan → approve → fan-out). Already does one human-in-the-loop
  pause, which is the right substrate for the converger.
- **Execution engine** — honest topological DAG execution with real inter-step
  data threading (`{{prev}}`, `{{nodeId.output}}`, transitive fan-in) and durable,
  cost-tracked run logs. The best-built part of the codebase. Instantiated and
  running (a mid-audit claim that it had been "deleted" was a false negative — see
  the tooling note below).
- **MCP connector runtime** — per-user subprocess isolation with an isolation
  test suite; manifest-driven, so connector #N is a config edit, not new plumbing.
- **Auth + credentials** — argon2id, revocable JWT sessions, AES-256-GCM-encrypted
  OAuth tokens, per-user store-layer scoping verified across 6+ stores.

### Capability scorecard

| Capability | Status | Disposition |
|---|---|---|
| **Conversational elicitation** | | |
| Convergence/gap state machine (propose → confirm → measure gap) | Missing | Greenfield (backend) |
| Per-step proposal + explicit confirmation | Missing backend | Greenfield |
| Live draft-vs-confirmed state in thread | Missing backend | Greenfield |
| `@`-callout resource grounding | Missing | Greenfield |
| Capability-schema grounding ("never propose the impossible") | Missing | Greenfield |
| **Workflow model & compilation** | | |
| Node-DAG persistence (triggers/nodes/edges/error_handling/versions) | Exists | Salvage |
| Structural validation | Exists | Salvage |
| Compile → portable format (BPMN/DMN) | Proprietary JSON only | Parked (keep JSON) |
| **Execution engine** | | |
| DAG executor + inter-step data passing | Exists & running | Salvage (high quality) |
| Schedule trigger | Daily granularity only | Refactor |
| Manual trigger (chat tool + REST) | Exists | Salvage |
| Event trigger ("when email from UPS arrives") | Missing | Greenfield |
| Error handling (retry/fallback/notify) | Field stored but inert | Refactor |
| Execution logging / run history | Exists (durable, cost-tracked) | Salvage |
| Concurrency (run locking, parallel) | Single-process serial | Refactor |
| **Connectors** | | |
| MCP runtime + per-user isolation | Exists (isolation-tested) | Salvage (strong) |
| Manifest-driven reusability | Exists | Salvage |
| Google (Gmail/Sheets/Forms) | Read-only, Drive only, binary unpinned | Refactor |
| Slack | Missing (fits existing mold) | Greenfield (small) |
| Airtable | Missing (may force API-fallback path) | Greenfield |
| Capability schema discoverable at elicitation | Tools dumped, no schema surface | Greenfield |
| OAuth credential encryption | AES-256-GCM, per-tenant | Salvage |
| **Frontend** (all rebuilt — see Part 2 note) | | |
| Console: workflow inventory | Exists (not reused) | Rebuild |
| Console: live run monitoring + per-run view | Exists (not reused) | Rebuild |
| SOP step-by-step definition view (branch/deps) | Flat chip strip | Rebuild |
| In-chat step-confirm builder | Built but dormant (not reused) | Rebuild |
| Keyboard-shortcut / floating-pill launcher | Missing | Greenfield |
| Two-surface "builder ↔ console toggle" model | Flat route nav | Rebuild |
| **Foundation** | | |
| Agent core (compiled StateGraph + checkpointer) | Exists | Salvage (good substrate) |
| Persistence (SQLite, ~8 stores) | Exists | Salvage |
| Auth (argon2id + JWT, revocable sessions) | Exists | Salvage |
| Per-user multi-tenancy (store-layer enforced) | Exists & verified | Salvage |
| Per-business/org tenancy | No org entity | Parked |
| Server-side conversation audit trail | localStorage v1 | Refactor |

### The two load-bearing gaps

**Gap 1 — The elicitation engine (the product's reason to exist).** Genuinely
greenfield on the backend. Today the agent either fills a form or calls
`create_workflow` once with a complete spec. The product needs the system to start
from a vague intent and close the gap through dialogue — proposing and confirming
one increment at a time while measuring distance to "complete" (trigger set,
actions defined, connectors resolved, transforms explicit, error paths defined).
Three things make this less than a from-scratch build: (a) the agent core is a
checkpointed state machine that already does one human-in-the-loop pause — the
right substrate; (b) the node-type registry already holds the per-step capability
schemas an elicitation loop needs to ground itself; (c) the emitted spec format is
already what the running engine executes. The build is the *converger* in the
middle.

> **Note:** the original audit found the in-chat UI for this loop ~80% built and
> dormant, which would have shrunk Gap 1 considerably. The decision to build all
> UI fresh removes that shortcut — Gap 1 is now its full size (converger backend +
> the entire conversational surface). This is the single biggest schedule item in
> the plan.

**Gap 2 — Event triggers.** The product's own canonical example — "every time we
get an email from UPS, post to Slack" — cannot run today, because the engine only
has schedule and manual triggers. A perfectly elicited spec would compile and then
have nothing to fire on. This is why the build plan interleaves connectors and
triggers with the converger rather than finishing the converger first.

### Tooling note (will bite the next session too)

`server.js` is stored with an encoding that makes plain `grep` silently return
zero matches. It convinced one audit sub-agent that the entire workflow engine had
been deleted — it had not; the file (~4,300 lines) fully wires the engine. **Re-save
`server.js` as clean UTF-8 in Phase 0** so your own tooling stops lying to you. Use
`grep -a` / `perl` until then.

---

## Part 2 — Pilot Build Plan

**Organizing principle:** thinnest runnable slice first, then thicken. De-risk the
integration plumbing *before* the converger, so the hard IP is built against a
target already known to run. The canonical demo ("UPS email → Slack") is runnable
in hand-authored form by the end of Phase 2 — every later phase thickens that spine
rather than being a prerequisite for anything running at all.

**On the all-fresh-UI decision:** building all UI from scratch is the right call
for a clean design language and no entanglement with dormant code, but it is the
biggest schedule mover here. Phases 4 and 5 are now full greenfield surfaces, not
re-wires. Protect them if the calendar tightens.

### Phase 0 — New repo, clean spine
Move the salvageable backend (agent core, execution engine, MCP runtime, auth,
credential vault, stores) into the production repo. Re-save `server.js` as clean
UTF-8. Stand up the empty new frontend shell. Decide the capability-schema format
now, before anything depends on it.
**Done when:** the existing engine boots in the new repo and the empty UI reaches
it over one health route.

### Phase 1 — Prove the spine with a hardcoded workflow (no converger)
Implement the Slack connector (post-to-channel), expose its capability schema,
hand-author a one-step spec, and run it from a button in the new UI through the
existing engine.
**Done when:** clicking "run" posts to Slack. Validates new repo ↔ engine ↔ MCP ↔
Slack ↔ new UI cheaply, and gives the converger a known-good spec shape to target.

### Phase 2 — Event triggers + Gmail
Add the missing event-trigger type to the engine, then implement Gmail read plus a
"new email matching filter" trigger.
**Done when:** a hand-authored "email from UPS → post to Slack" spec fires on a
real email. The canonical demo now runs — still hand-written, no converger.

### Phase 3 — The converger (the IP; long pole)
Build the propose → confirm → measure-the-gap loop on top of the existing
checkpointed `StateGraph`, grounded in the Phase 1–2 capability schemas so it can't
propose the impossible, emitting the same JSON spec Phase 2 proved runnable. Build
it headless first, driven by a test harness.
**Done when:** from a vague typed intent, the converger reproduces the exact UPS
spec you hand-authored, with each step's confirmation logged. Building against a
fixed target keeps this phase honest.

### Phase 4 — Conversational builder UI (greenfield)
The chat surface: inline step-proposal cards, explicit per-step confirm, live
draft-vs-confirmed state, wired to the converger's event contract. `@`-callouts
slot in here as optional polish (the converger must work without them by
definition).
**Done when:** Maggie builds the UPS workflow entirely by talking and confirming,
and it runs.

### Phase 5 — Console UI (greenfield)
Inventory, live run monitoring, and the step-by-step SOP view with dependencies.
**Done when:** she sees her automations, watches a run execute step-by-step, and
reads the logs.

### Phase 6 — Launcher + two-surface model
Floating pill / keyboard-shortcut summon; toggle between builder and console.
**Done when:** summon from anywhere, switch surfaces cleanly.

### Phase 7 — Third connector + reliability
Airtable (likely the API-fallback path — budget for it), Google write plus Sheets/
Forms, error handling (retry/notify on failure), and sub-daily scheduling.
**Done when:** all three of Maggie's connectors are live, failures retry and
notify, and "executes reliably" is actually true.

### Risk concentration & cut order
Phases 3 and 4 are most of the real work and most of the unknowns; the all-fresh-UI
decision made Phase 4 bigger. Protect those two if the calendar gets tight. The
first thing to cut to a fast-follow after demo day is Phase 7's third connector
(Airtable) — never the converger.

### Parked (out of pilot scope)
- **Per-business / org tenancy.** Additive `business_id` migration across stores +
  the agent session key. Invisible for a single-user pilot; revisit at customer #2.
- **BPMN/DMN portability.** The engine runs its own JSON fine. Revisit when a
  customer's procurement actually requires a portable format.
