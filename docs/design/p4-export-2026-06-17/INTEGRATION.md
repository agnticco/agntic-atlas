# Atlas — Frontend ↔ Backend Integration Guide

Implementation handoff. Three dark-themed Design Components make up the product UI.
Every screen is **real, production-ready layout**; all data is **neutral placeholder**
clearly marked `INTEGRATION:` in the source. Replace the placeholder constants with
backend responses and wire the `on*` callbacks to the endpoints below.

| File | Screen | Role |
|---|---|---|
| `Atlas Builder (Skeleton).dc.html` | Builder | Main app shell. Conversation → Test → Draft → Live → Connections, all in one window. |
| `Atlas - Draft Review.dc.html` | Draft Review | Standalone approval screen — the state after every step is confirmed + test passes, before publish. |
| `Atlas - Live Dashboard.dc.html` | Live Dashboard | Standalone "observing" screen for a published workflow: health, DAG, filterable run ledger + run-detail drawer. |

> The Builder's **Draft** and **Live** panes mirror the two standalone screens. Treat the
> standalone files as the canonical, fully-featured versions of those screens; the Builder
> embeds compact versions for the in-app transition.

---

## 1. Data models

### Workflow  (`GET /workflows/:id`)
```
id            UUID (PK)
slug          URL-safe, unique per (user_id, slug)
tenant_id     TEXT, default 'default'
user_id       owner
session_id    nullable — conversation that created it
kind          'fetch' (legacy polling) | 'flow' (DAG)
status        'active' | 'paused' | 'error' | 'draft'
version       integer, bumped on definition change
name, description, user_intent
triggers[]    { type, filter?, maxResults?, userId?, config?: { time?, cron? } }
nodes[]       { id, type, label, config:{...} }   // type ∈ node-type registry
edges[]       { from: nodeId, to: nodeId }
error_handling JSON
source_id, schedule, output_format, delivery, config   // legacy fetch-kind, '' default
created_at, updated_at, last_run
```

**Node-type registry** (`node.type`): `trigger`, `summarize`, `deliver`, `fetch`,
`extract`, `rewrite`, `llm`, `tool`, `mcp-tool`, `search-web`, `daily-digest`.

### Run  (execution record — feeds the Live Dashboard ledger + drawer)
Inferred shape — **confirm against your runs table** and rename to match.
```
id               run id
workflow_id
workflow_version integer — which version executed
status           'success' | 'failed' | 'running' | 'skipped'
trigger          { type, source, category }   // source = matched sender/source id
started_at, finished_at, duration_ms
node_results[]   { node_id, type, label, status, ms, output?, error? }
fail_node        nodeId | null  — failure point
current_node     nodeId | null  — for in-flight runs
output           { channel, message } | null   // shape varies by destination
error            { node, message } | null
```

### Proposal  (planner output — drives the Builder conversation)
```
{ tag, heading, reason, spec: [[key,value], …], node, clarify?: { q, chips[] } }
```

### Connection  (`GET /connections`)
```
{ provider, name, meta, status: 'connected' | 'available', glyph }
```

---

## 2. Endpoint contract

REST conventions below match the `INTEGRATION:` notes in code. Confirm verbs/paths with your API.

| Method | Endpoint | Used by |
|---|---|---|
| `GET` | `/workflows` | Builder sidebar list |
| `POST` | `/workflows` | Builder "+ New workflow" |
| `GET` | `/workflows/:id` | identity, nodes, edges, status, version (all screens) |
| `PATCH`| `/workflows/:id` | rename / edit definition (bumps `version`) |
| `POST` | `/workflows/:id/plan` | submit intent → first proposal (Builder) |
| `POST` | `/workflows/:id/plan/step` | propose next step given conversation; also handles confirm / change / reject turns |
| `POST` | `/workflows/:id/test` | end-to-end test run; stream per-step results (Builder test panel) |
| `POST` | `/workflows/:id/publish` | approve draft → live (Draft Review) |
| `POST` | `/workflows/:id/pause` | pause a live workflow (Live Dashboard) |
| `GET` | `/workflows/:id/metrics` | health rollup tiles (Live Dashboard pulse band) |
| `GET` | `/workflows/:id/runs?status=&source=&failNode=&from=&q=` | run ledger (Live Dashboard table — server-side filtering preferred) |
| `GET` | `/workflows/:id/runs/:runId` | run-detail drawer |
| `GET` | `/connections` | Connections page + sidebar count |
| `POST` | `/connections/:provider` | connect an available app |

---

## 3. Screen-by-screen element map

### A. `Atlas Builder (Skeleton).dc.html`
Logic seams (methods): `submitIntent` · `advance` · `confirm` / `openChange` / `submitChange` / `reject` / `pickChannel` · `runTest` · `reviewDraft` / `approveDraft` / `keepBuilding`.

| Region (template comment) | Purpose | Backend |
|---|---|---|
| `TITLE BAR` | Current workflow name (`windowTitle`) | `GET /workflows/:id` → `name` |
| `LEFT` → Workflows list (`sidebarWorkflows`) | Other workflows; dot color = status | `GET /workflows` (placeholder `MOCK_WORKFLOWS = []`) |
| `LEFT` → `+ New workflow` (`onReset`) | Start a fresh build | `POST /workflows` |
| `LEFT` → Connections button | Open Connections page; badge = connected count | `GET /connections` |
| `CONVERSATION` thread + input | The build dialogue. Intent in → proposals out, one step at a time | `submitIntent` → `POST …/plan`; `advance` → `POST …/plan/step`. Replace `PLAN_DELAY_MS` timers with awaits. Proposals come from `STEPS` placeholder. |
| Proposal card actions | Confirm / Change it / Not this | planner turns via `confirm`/`submitChange`/`reject` |
| `RIGHT` → Test environment | Fire every step against a sample event | `runTest` → `POST …/test`; stream results into `testStep` / `testState` (`passed`\|`failed`+`failIndex`) |
| `MODE: DRAFT` | In-app draft review (mirrors Draft Review screen) | `reviewDraft`; `onApprove` → `POST …/publish`; `onKeepBuilding` returns to conversation |
| `MODE: LIVE` | In-app live dashboard (mirrors Live Dashboard screen) | `approveDraft` seeds it; wire to `GET …/metrics` + `GET …/runs` |
| `MODE: CONNECTIONS` | Connected + available apps | `GET /connections`; Connect → `POST /connections/:provider` |

Placeholder constants to replace: `GREETING`, `SUGGESTIONS`, `MOCK_WORKFLOWS`, `CONNECTED`, `AVAILABLE`, `STEPS`, `EMAIL`, `RUNS`, `TEST_CHECKS`.

### B. `Atlas - Draft Review.dc.html`
Props-driven (see `data-props`). Defaults live in `EXAMPLE` (neutral placeholder).

| Element | Purpose | Backend |
|---|---|---|
| Title + intro | Workflow identity awaiting approval | `workflowTitle` ← `workflow.name` |
| "The workflow" pipeline (`nodes`) | The assembled steps, each with a monospace spec | `workflow.nodes` → `{ label, title, spec }` |
| "Sample trigger" card (`trigger`) | A representative inbound event | example trigger payload for this trigger |
| "What your team sees" (`output`) | **Takes the shape of the delivered object** — render per destination (Slack/email/doc/row/…) | final node's rendered output |
| `Revise` (`onKeepBuilding`) | Return to the Builder conversation | — |
| `Approve & go live` (`onApprove`) | Publish | `POST /workflows/:id/publish` → route to Live Dashboard |

### C. `Atlas - Live Dashboard.dc.html`
Props-driven (`workflow`). Placeholder constants: `WF`, `CATS`, `RAW`.

| Element | Purpose | Backend |
|---|---|---|
| Header (name, status pill, kind, version, dates) | Workflow identity + state | `GET /workflows/:id` |
| `Pause` / `Modify` | Control the live workflow | `POST …/pause` / open Builder |
| Pulse band (runs, delivered %, median, failures) | Health rollup | `GET …/metrics` (example computes from `RAW`) |
| Pipeline DAG | `nodes[]` + `edges[]`, typed | `workflow.nodes` / `edges` |
| Filter toolbar | search · date · source · failure-point · status segmented | maps to `GET …/runs` query params |
| Run table (`RAW`) | One row per execution, every outcome state | `GET …/runs` |
| Run-detail drawer | Per-step trace, error block, delivered output | `GET …/runs/:runId` |

---

## 4. Conventions baked into the UI
- **Status → color**: active/success `#7FC28A` · pending/running `#F0BF6B` · error/failed `#E87461` · idle/skipped white-30%.
- All copy text and single colors are **directly editable** in the design tool; structural/behavioral changes are code.
- No real timers in production: every `after(...)` / `*_DELAY_MS` stub stands in for an `await`.
