# Atlas

A conversational AI workflow builder by **Agntic**. Users build automations by
talking — the system proposes one step, the user confirms, it measures the gap to
a complete spec, and repeats until the workflow is finalized. Finished workflows
compile to a proprietary JSON spec that the execution engine runs and makes
observable through a live console.

The hard IP is the **converger** — the conversational elicitation engine that turns
a vague intent into a runnable spec without ever proposing something the wired
connectors can't do.

## Status

| Phase | What | State |
|---|---|---|
| **P0** | Clean spine — execution engine + auth/credential vault boot in the new repo; `GET /health` | ✅ merged |
| **P1** | Slack connector — hand-authored spec posts to Slack; scope-aware capability map; per-tenant OAuth install | ✅ merged |
| — | **Multi-tenancy** — hard, fail-closed per-tenant data isolation (foundational) | ✅ merged |
| **P2** | Event triggers + Gmail — UPS→Slack spec fires on real email; G-Suite connector (20 actions); cloud inference | ✅ merged |
| **P3** | The **converger** (the IP) — elicitation engine, interaction store | ✅ merged |
| **P4** | Builder UI — workflow built entirely by talking | ✅ merged |
| **P5** | Console UI — inventory, live run monitoring, SOP view + PDF/MD export | ✅ merged |
| **P6** | Launcher + builder↔console toggle | ▶ next |
| P7–P11 | Third connector · reliability · value tracking · admin observability · production hardening | planned |

Each ✅ was closed by an independent **Verifier** against a fail-closed gate; the
evidence lives in [`docs/gates/`](docs/gates/) and `git log --grep "^Gate:"`.

## What's built

- **Execution engine** (`src/workflows/`) — topological DAG executor with real
  inter-step data threading (`{{prev}}`, `{{nodeId.output}}`, transitive fan-in),
  11 node types, durable cost-tracked run logs. A `ModelPool` (Anthropic/OpenAI
  cloud or local GGUF) is injected as the engine's LLM.
- **Auth + credential vault** (`src/auth/`) — argon2id passwords, revocable JWT
  sessions (with a tenant claim), AES-256-GCM-encrypted OAuth tokens. Every store
  is **tenant-scoped and fail-closed** (throws on a missing tenant — no silent
  unscoped reads).
- **Multi-tenancy** — each client is a tenant; users and all resources live under
  a `tenant_id`. Auth/vault/workflows use a shared DB with a bound scoping layer;
  **RAG is physically isolated per tenant** (its own store per tenant). One
  tenant's data can never surface in another's — proven by an adversarial suite.
  See [`docs/architecture/multi-tenancy.md`](docs/architecture/multi-tenancy.md).
- **Local models + RAG** (`src/llm/`, `src/rag/`) — open-source models locally
  via `node-llama-cpp` (cloud optional), company-context RAG with local GGUF
  embeddings + a per-tenant vector store.
  See [`docs/capabilities/local-models-rag.md`](docs/capabilities/local-models-rag.md).
- **Slack connector** (`src/connectors/slack/`) — delivery channel
  (`chat.postMessage`) plus a full OAuth install flow; tokens encrypted per tenant;
  scope-aware capability map feeds the converger.
  See [`docs/connectors/slack.md`](docs/connectors/slack.md).
- **G-Suite connector** (`src/connectors/google/`) — Gmail (search, send, read,
  mark-read), Docs, Sheets, Drive, Calendar, Tasks. Full OAuth 2.0 with PKCE;
  Gmail trigger fires on incoming email matching a per-workflow filter. 20-action
  capability map.
- **Converger** (`src/converger/`, `src/graph/`) — elicitation engine built on a
  custom `StateGraph` + HITL interrupt/resume loop. Proposes one spec element at a
  time, checks against the live capability catalog, logs every confirmation, and
  emits a runnable JSON spec. Non-deterministic but gated against a frozen
  canonical spec (`docs/specs/canonical-ups-slack.json`) for structural equivalence
  and end-to-end runnability.
- **Builder UI** (`public/index.html`, `src/api/builder.js`) — single-page
  conversational builder. The user describes what they want to automate; the
  converger drives the dialogue, proposes steps, surfaces inline confirmations, and
  publishes the finished workflow. Glassmorphic sidebar with collapsible panel,
  flyout popovers (Account, Connections, Recently Deleted), and a tutorial on first
  login.
- **Console UI** (`src/api/console.js`, `public/index.html`) — per-workflow
  dashboard with live run history, per-step execution drawer (inputs/outputs/timing),
  success-rate metrics, pipeline DAG visualization, pause/resume/run-now controls,
  and an SOP tab with one-click Markdown or PDF export.
- **SOP export** (`src/workflows/sop-generator.js`, `src/workflows/sop-pdf.js`) —
  generates a structured Standard Operating Procedure from a workflow spec:
  trigger, step-by-step instructions, data-flow chain, dependencies. Rendered as
  Markdown or a formatted PDF (pdfkit).
- **Cloud inference** (`src/llm/`) — `buildLLM()` prefers Anthropic (haiku/sonnet
  tiers) when `ANTHROPIC_API_KEY` is set, falls back to OpenAI, then local GGUF
  weights.

## Running it

Requires **Node ≥ 22**. Native deps (`better-sqlite3`, `argon2`, `node-llama-cpp`)
build on install.

```bash
npm install
npm start            # boots the spine on :3000
curl localhost:3000/health
```

**Model weights are gitignored** (large GGUF binaries) and fetched out-of-band —
see [`docs/capabilities/local-models-rag.md`](docs/capabilities/local-models-rag.md).
The engine boots without them (`llm:"unconfigured"` until present).

### HTTP surface

**Auth & setup**
- `GET /health` — engine / auth / llm / rag status (unauthenticated)
- `POST /setup` — first platform admin
- `POST /auth/login`, `POST /auth/logout`

**Tenant management** (platform admin)
- `GET|POST /tenants`, `POST /tenants/:id/users`, `POST /tenants/:id/status`

**User preferences** (auth required)
- `GET|PUT /api/user/preferences` — homepage module toggles

**Connectors / OAuth**
- `GET /connectors/slack/authorize`, `/callback`, `/status`, `DELETE /connectors/slack`
- `GET /connectors/google/authorize`, `/callback`, `/status`

**Google actions** (auth required)
- `POST /google/gmail/{search,get,send,mark-read}`
- `POST /google/docs/{create,read}`, `/sheets/{read,append}`, `/calendar/{events,create}`, `/tasks/{list,create}`

**Capabilities & execution**
- `GET /capabilities` — per-tenant live capability catalog
- `POST /workflows/run` — ad-hoc run with optional `initialContext`

**Builder** (auth required)
- `GET /api/builder/me` — session hydration
- `POST /api/builder/chat` — converger turn
- `GET|POST /api/builder/workflows` — list + publish
- `GET|PUT|DELETE /api/builder/workflows/:id` — manage; `POST /:id/restore`
- `GET /api/builder/workflows/deleted` — recently deleted
- `GET /api/builder/greeting` — AI home greeting
- `GET /api/builder/connections` — connector status

**Console** (auth required)
- `GET /api/console/workflows` — tenant-scoped inventory
- `GET /api/console/workflows/:id/runs` — paginated run history
- `GET /api/console/workflows/:id/runs/:runId` — run detail with per-step data
- `POST /api/console/workflows/:id/run` — run now
- `POST /api/console/workflows/:id/pause`, `/resume`
- `GET /api/console/workflows/:id/sop` — SOP Markdown
- `GET /api/console/workflows/:id/sop/pdf` — SOP PDF download

**RAG** (auth required)
- `POST /rag/ingest`, `POST /rag/query`

## Verification & gates

Each phase has a fail-closed check in `scripts/gates/p<n>.sh`, run via
`scripts/gate.sh <n>`. A phase closes only when a fresh Verifier (which did not
write the code) passes the check and records `docs/gates/<gate>.md`. A `pre-push`
hook blocks publishing a `Gate:`-trailer commit unless its check passes.

```bash
bash scripts/gate.sh 5                       # console UI gate (15 checks)
bash scripts/gates/cap-multitenancy.sh       # cross-tenant isolation
bash scripts/gates/cap-slack-oauth.sh        # per-tenant Slack OAuth
```

## Repo layout

```
src/
  api/         server.js (spine) · builder.js · console.js
  workflows/   DAG executor · stores · scheduler · node types · sop-generator · sop-pdf
  auth/        users · sessions · tenants · JWT · AES-256-GCM OAuth vault
  llm/         local (node-llama-cpp) + cloud models · ModelPool · cost tracker
  rag/         embeddings · per-tenant vector store · retrievers · ingestion
  connectors/  Slack (delivery + OAuth) · Google/G-Suite (20 actions) · connector manifest
  converger/   elicitation engine · prompts · interaction store
  graph/       custom StateGraph · HITL interrupt/resume
  core/ utils/ shared primitives
public/        single-page builder + console UI (index.html)
docs/          build plan · architecture · connector docs · gate ledgers · design mockups
scripts/gates/ per-phase + capability checks
```

## Build orientation

- **The plan:** [`docs/agntic-ops-gap-and-build-plan.md`](docs/agntic-ops-gap-and-build-plan.md) — gap map + sequenced phase plan.
- **Build constitution:** [`CLAUDE.md`](CLAUDE.md) — closed decisions, the don't-touch salvage list, multi-tenant conventions. Read first, every session.
- **Commit convention:** [`docs/COMMIT_CONVENTION.md`](docs/COMMIT_CONVENTION.md) — Conventional Commits + phase/gate tags, enforced by a `commit-msg` hook.

### Repo setup

```bash
git config core.hooksPath .githooks
git config commit.template .gitmessage
```
