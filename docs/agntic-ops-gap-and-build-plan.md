# Agntic Ops — Gap Map & Pilot Build Plan

A single handoff document for a build session. Part 1 is the audit verdict: what
exists, what's missing, and the two load-bearing gaps. Part 2 is the sequenced
build plan that closes those gaps for the Innovation Depot pilot.

**Scope decisions baked into this plan:**

- **All UI is built fresh.** No existing frontend is reused; no re-wiring of the
  dormant in-chat builder. This is a deliberate call — see the note under Part 2.
- **Multi-tenant from the foundation** *(added 2026-06-09, reverses the earlier
  "no tenancy in pilot" decision).* Each onboarding client gets a `tenant_id`.
  See ENGINEERING-LOG.md and `docs/architecture/multi-tenancy.md`.
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

### Phase 5 — Console UI + SOP export (greenfield)

> **Runway / readiness (grounded 2026-06-18, after P4 merge):**
> [`docs/design/p5-readiness.md`](design/p5-readiness.md). Key facts the deferral
> notes understated: the **store/ledger layer already exists** — `workflow_runs` is
> populated by the scheduler (`startRun`/`completeRun`), and `workflow-store.js`
> already has `list()` (inventory), `getRuns()` (ledger), `getRun()` (drawer),
> `getRecentRuns`, `getCostByWorkflow`, `getVersions`. So **P5 ≈ mount read endpoints
> over existing methods + build the console UI + net-new SOP export** (no SOP/PDF/MD
> scaffolding exists). ⚠ **Tenancy flag:** the run-query methods are **not
> tenant-scoped** (`getRuns`/`getRun` take only `userId`, no `tenantId`; `list()`
> returns unscoped when no tenant passed) — every new read endpoint must pass
> `req.tenant.id` and the query methods need a `tenantId` param, proven by an
> adversarial cross-tenant test. Builder "Run test" (`/workflows/run`) does **not**
> record runs (only the scheduler does). Live Dashboard design target:
> [`docs/design/mockups/`](design/mockups/). No mock data (P4 Draft-page lesson).

Inventory, live run monitoring, and the step-by-step SOP view with dependencies.
Includes SOP export: from any activated workflow's SOP view, generate a
formatted export that documents every step, decision point, and connector in
plain language — exported as both **PDF** (for stakeholder hand-off) and
**Markdown** (version-controllable, paste-anywhere source). The export is derived
directly from the live spec, so it stays in sync with the workflow as it evolves.
**Done when:** she sees her automations, watches a run execute step-by-step,
reads the logs, and can export the UPS workflow's SOP as a PDF and Markdown file.

> **Live Dashboard design target (approved 2026-06-18; deferred here from P4).** The
> analytical live-run dashboard is **P5**, not P4 — the current P4 live view is a minimal
> "workflow is live" confirmation on purpose. Design reference saved at
> [`docs/design/mockups/Atlas - Live Dashboard.dc.html`](design/mockups/) (+ drawer/output
> screenshots). It is an ops/analytics view: status header (active/paused), a **health
> "pulse band"** (success rate, run counts), a **filterable run ledger** (one row per
> execution; filters: date/status/source/step/search), and a **per-run detail drawer**
> (step-by-step timings, trigger payload, delivered output, error). **Backend it needs
> (none built yet):** `GET /workflows/:id` (identity+DAG+health), `GET /workflows/:id/metrics`
> (rollup), `GET /workflows/:id/runs?status=&source=&failNode=&from=&q=` (ledger), `GET
> /workflows/:id/runs/:runId` (trace), `POST .../pause`. The `workflow_runs` table already
> exists in `src/workflows/workflow-store.js` (started_at, steps, tokens_in/out, is_test) —
> so storage is scaffolded; what's missing is **confirming runs are recorded for scheduled +
> test executions**, the **query methods + endpoints**, and the UI. Do NOT populate it with
> mock run data (the fake-data anti-pattern removed from the P4 Draft page on 2026-06-18).

### Phase 6 — Launcher + two-surface model
Floating pill / keyboard-shortcut summon; toggle between builder and console.
**Done when:** summon from anywhere, switch surfaces cleanly.

### Phase 7 — Third connector + reliability
Airtable (likely the API-fallback path — budget for it), Google write plus Sheets/
Forms, error handling (retry/notify on failure), and sub-daily scheduling.
**Done when:** all three of Maggie's connectors are live, failures retry and
notify, and sub-daily schedules fire correctly.

> **PREREQUISITE — position-agnostic capability substrate (surfaced during P4, 2026-06-18).**
> Before wiring more connector execution, do **Increment 1 (full unify)** from
> [`docs/architecture/connector-capabilities.md`](architecture/connector-capabilities.md):
> fold the three position-siloed registries behind ONE `CapabilityRegistry` that the
> engine (`connector-action` step + `deliver`), the trigger system, the converger, and
> the UI all read. Today a connector capability's reachability depends on *where* it sits:
> `connector-action` resolves only `channelRegistry` (Slack), the email trigger lives in a
> separate `gmail-source.js`, and Google's handlers (`src/connectors/google/index.js`) are
> registered into none of those paths — so `gmail_search` exists but runs nowhere. A
> capability's full ability must be the **same regardless of position** (trigger / step /
> delivery); capabilities should declare their allowed positions (note: `capabilities.json`
> has no `position` field yet). This also forces the deferred **execution-identity** decision
> (per-tenant bot token vs per-user OAuth; whose account a *scheduled* run uses). This is the
> code inflexibility that blocked building non-Slack workflows in the P4 builder — the builder
> mechanism was verified on the runnable Slack path only.

> **Slack connector reliability residuals (surfaced while verifying P4, 2026-06-18).** Found by
> running real Slack-only workflows through the builder + a scope audit. None were UI/builder
> defects — the builder loop (chat → propose → modify → ratify → run → per-step results)
> worked; these are connector-layer issues to fix when P7 hardens connectors:
> 1. **DM recipient resolution uses the known-unreliable `users.lookupByEmail`.**
>    `resolveUser` in `src/connectors/slack/index.js` (~line 224) calls `users.lookupByEmail`,
>    which the codebase *already* documents as flaky "even with confirmed emails + `users:read.email`"
>    (see the `slack_lookup_user` handler ~line 461, which switched to a `users.list` scan). The
>    DM path (`slack_dm`, `slack_dm_as_user`) was never updated — it failed live with
>    `invalid_arguments`. Fix: resolve DM recipients via the same `users.list` scan.
> 2. **`post_dm` capability under-declares its scopes.** `capabilities.json` lists
>    `requiredScopes: [chat:write, im:write]` but the handler also needs `users:read.email`
>    (for the email lookup). So the converger can mark DM "available" when the runtime can't run it.
>    Fix: declare the full scope set per capability (and have resolution reflect runtime needs).
> 3. **Scope-request derivation is fragile.** The OAuth flow derives the scopes it *requests* from
>    the reference token (`SLACK_BOT_TOKEN`, floored at `chat:write`). A dead/stale reference token
>    silently collapses every install to `chat:write` with no error — exactly what happened here
>    (audit showed the tenant grant = `chat:write` only until a valid reference token was set + a
>    reconnect). The explicit `SLACK_OAUTH_SCOPES` override was removed earlier; the substrate
>    should request an explicit desired-scope set rather than infer it from a token that may be invalid.
> 4. **Converger may emit a non-clean-email `user` for DMs** (the `invalid_arguments` vs
>    `users_not_found` distinction suggests a malformed value, e.g. a handle). Tighten the prompt /
>    validate the `slack_dm` `user` field once #1 lands.

### Phase 8 — Web research + filesystem connectors
*(Scope re-decided: no Tavily/Firecrawl. Fully self-owned.)*

**Web connector** (`src/connectors/web/`) — two capabilities (step position):
- `web_search`: Anthropic native `web_search_20260209` tool via the existing LLM
  service. `isReady()` = `ANTHROPIC_API_KEY` is set. Converger surfaces it
  automatically from the CapabilityRegistry when the connector is available.
- `web_fetch`: fetches a URL and extracts readable article content using Mozilla
  Readability + jsdom (Firefox Reader Mode). Always ready; no API key required.

**Filesystem connector** (`src/connectors/filesystem.js`) — two capabilities
(step position): `filesystem_read` and `filesystem_list`. Every call is sandboxed
to the tenant's approved folders (absolute-path entries in `sources.json` added
via `/rag/index-folder`). Browser-upload entries are RAG-only and ineligible.
`injectFilesystemContext()` stamps `_tenantId` into filesystem nodes before every
run path (REST, scheduler, Slack event dispatch, Airtable event dispatch).

**Done when:** gate `scripts/gates/p8.sh` — 20 checks covering both connectors,
sandbox guard, and filesystem read end-to-end. Gate closed 2026-06-21.
Airtable E2E verification (create record via workflow, confirm it lands) tracked
separately (`scripts/checks/p8-airtable-e2e.mjs`).

### Phase 9 — Workflow profile page (value + trust narrative)
A per-workflow profile that makes the automation's value tangible to an ops
director or buyer. Core concept: capture the manual version of the task as a
baseline at build time, then show every automated run measured against it.

**Baseline capture (build time):** the operator records a screen capture of doing
the task manually and enters how long it takes. Both are stored with the workflow.
This is the proof of equivalence — "same workflow, automated."

**Per-run tracking:** execution time is recorded for every run and compared to
the baseline duration. Running total of time saved (runs × (baseline − execution
time)) accumulates as YTD savings.

**Profile surface:** a dedicated page per workflow showing: baseline duration,
last-run execution time, total time saved YTD, a trend line over recent runs,
example outputs from past runs, and a link to the baseline screen recording.

**Why this matters:** ops directors need a trust-building narrative, not just a
toggle. The profile gives them a one-screen answer to "is this doing what the
manual process did, and how much time is it saving?"

*(Cost tracking moved to P10.)*

**Done when:** a workflow run records execution time; the profile page renders
baseline, execution time, time-saved YTD, trend, example outputs, and baseline
recording; the page is accessible from the console workflow detail view.

### Phase 10 — Admin observability + cost tracking
A separate internal-facing web dashboard — not the user-facing console — for
monitoring per-tenant usage and economics.

**Usage observability:** run counts and frequency per tenant, connector call
volume, error rates, workflow health at a glance.

**Cost tracking (feeds unit economics):** every LLM call is tagged by type
(converger turn, workflow execution node, UI/chat interaction). Per-tenant cost
is segmented by call type so variable costs are visible at the account level.
Lifetime and estimated monthly cost per tenant are surfaced in the dashboard.
This data feeds the unit economics model — variable cost per workflow run, per
tenant, per month — which anchors pricing decisions for paid pilots.

Built as a standalone Atlas admin app (separate route/service from the
user-facing product) to keep operator concerns out of the customer UI.

**Done when:** the admin dashboard shows per-tenant run counts, LLM cost broken
down by call type, estimated monthly burn per tenant, and error rates in real
time; data is not visible to non-admin users.

### Phase 11 — E2E validation + production hardening + VPS migration
End-to-end test suite covering the full user journey (builder → run → console →
SOP export → value summary), cross-tenant isolation proofs, and production
hardening (rate limits, audit logging, backup/recovery). Migration from current
hosting to a VPS with a documented deployment runbook.
**Done when:** the full E2E suite passes on VPS infrastructure; cross-tenant
isolation is proven adversarially; the deployment runbook produces a clean
environment from scratch; DNS points at the VPS and production smoke tests pass.

### Risk concentration & cut order
Phases 3 and 4 are most of the real work and most of the unknowns; the all-fresh-UI
decision made Phase 4 bigger. Protect those two if the calendar gets tight.
Cut-order for fast-follows after the core demo: P7 Airtable connector first
(never the converger), then P8 web + filesystem, then P9 value tracking, then
P10 admin observability. P11 is non-negotiable before any external customer sees
production data.

### Parked (out of pilot scope)
- **BPMN/DMN portability.** The engine runs its own JSON fine. Revisit when a
  customer's procurement actually requires a portable format.
