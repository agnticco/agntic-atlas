# Atlas

A conversational AI workflow builder by **Agntic**. Users build automations by
talking — the system proposes one spec element at a time, the user confirms, it
measures the gap to a complete spec, and repeats until the workflow is finalized.
Finished workflows compile to a proprietary JSON spec that the execution engine
runs and makes observable through a live console.

The hard IP is the **converger** — the conversational elicitation engine that
turns a vague intent into a runnable spec without ever proposing something the
wired connectors can't do.

## Status

| Phase | What | State |
|---|---|---|
| **P0** | Clean spine — execution engine + auth/credential vault boot in the new repo; `GET /health` | ✅ merged |
| **P1** | Slack connector — hand-authored spec posts to Slack; scope-aware capability map; per-tenant OAuth install | ✅ merged |
| — | **Multi-tenancy** — hard, fail-closed per-tenant data isolation (foundational) | ✅ merged |
| **P2** | Event triggers + Gmail — UPS→Slack spec fires on real email; G-Suite connector; cloud inference | ✅ merged |
| **P3** | The **converger** (the IP) — elicitation engine, interaction store | ✅ merged |
| **P4** | Builder UI — workflow built entirely by talking | ✅ merged |
| **P5** | Console UI — inventory, live run monitoring, SOP view + PDF/MD export | ✅ merged |
| **P6** | *(scrapped 2026-06-20)* — current sidebar + surface switching is sufficient; floating pill / launcher layer dropped | — |
| **P7** | Airtable connector + Google write-back + error handling with retry/notify + sub-daily scheduling | ✅ merged |
| **P8** | Web research (`web_search` / `web_fetch` connector) + filesystem connector (tenant-sandboxed read/list) | ✅ merged |
| — | **Web connector** — `web_search` (Anthropic native tool) + `web_fetch` (Readability); no API key beyond `ANTHROPIC_API_KEY` | ✅ shipped post-P8 |
| — | **Airtable E2E verification** — create dummy base, test record creation end-to-end via workflow | ✅ verified |
| **P9** | **Workflow profile page** — baseline screen recording + duration captured at build time; per-run execution time tracked and compared to baseline; profile displays baseline, execution time, total time saved YTD, trend line, example outputs, and the baseline recording. Enables the trust-building narrative for ops directors: *"same workflow, automated."* | planned |
| **P10** | Admin console — per-tenant usage monitoring + **cost tracking**: LLM spend segmented by call type (converger, execution, UI), lifetime cost per tenant, estimated monthly burn. Feeds unit economics modeling. | planned |
| **P11** | E2E validation + production hardening + VPS migration | planned |

Each ✅ was closed by an independent **Verifier** against a fail-closed gate;
the evidence lives in [`docs/gates/`](docs/gates/) and `git log --grep "^Gate:"`.

## Parallel work (next 2–3 weeks)

Work that runs alongside the phase sequence:

- **Anthropic invoice** — get actual spend data this week; baseline for unit economics
- **Cost instrumentation** — tag every LLM call by type (converger turn, workflow execution, UI/chat) so spend is segmentable per tenant
- **Unit economics spreadsheet** — variable costs, fixed costs, target price per workflow or per tenant
- **Anchor pricing** — derive a paid-pilot price from real cost data before the first commercial conversation
- **Converger iteration** — ongoing prompt + elicitation quality improvements as pilot workflows surface edge cases
- **HubSpot build** — first real-customer workflow built in parallel with converger iteration
- **Load test** — after pilot workflows are stable; gate for P11

## What's built

### Execution engine (`src/workflows/`)

Topological DAG executor with real inter-step data threading (`{{prev}}`,
`{{nodeId.output}}`, transitive fan-in). A `ModelPool` (Anthropic/OpenAI cloud
or local GGUF) is injected as the engine's LLM. Durable cost-tracked run logs.

**12 node types** (all runnable today):

| Node | Purpose |
|---|---|
| `summarize` | Summarize text with AI |
| `llm` | Run a custom AI prompt |
| `extract` | Extract structured fields from text |
| `rewrite` | Rewrite / transform text |
| `search_web` | Web search via Anthropic's native `web_search_20260209` tool (built-in; superseded by the Web connector-action — use `connector-action` with `action:"web_search"` instead) |
| `connector-action` | Call a connector capability mid-workflow (fetch, create, update) |
| `deliver` | Send the final result to a destination (Slack, email, in-app inbox, webhook) |
| `trigger` | Entry node (created from the trigger spec; not proposed by the converger) |
| `daily-digest` | Scheduled digest aggregation |
| `fetch` | HTTP fetch (requires registered source; not yet wired to connectors) |
| `tool` / `mcp-tool` | Agent tool calls (not yet runnable — no ToolRegistry wired) |

### Auth + credential vault (`src/auth/`)

Argon2id passwords, revocable JWT sessions (with a tenant claim), AES-256-GCM
encrypted OAuth tokens. Every store is **tenant-scoped and fail-closed** (throws
on a missing tenant — no silent unscoped reads).

### Multi-tenancy

Each onboarding client is a tenant. Users and all resources live under a
`tenant_id`. Auth/vault/workflows use a shared DB with a bound scoping layer;
**RAG is physically isolated per tenant** (its own store per tenant). One
tenant's data can never surface in another's — enforced by store-level guards and
proven by an adversarial suite.
See [`docs/architecture/multi-tenancy.md`](docs/architecture/multi-tenancy.md).

### Capability registry (`src/connectors/capability-registry.js`)

Unified, position-agnostic catalog. Each capability declares which positions it
can occupy (`trigger` / `step` / `delivery`), its required scopes, and real-time
availability from the tenant's granted scopes. The converger, engine, and UI all
read from the same catalog — any connected connector can be used at any position
in a workflow. Replaces the old fragmented ChannelRegistry / per-connector silos.

### Connectors

#### Slack (`src/connectors/slack/`)

Delivery channel (`chat.postMessage`), DM delivery (`slack_dm`), OAuth install
flow (per-tenant bot token, encrypted), `slack_message` and `slack_mention`
event triggers. Full scope-aware capability map.
See [`docs/connectors/slack.md`](docs/connectors/slack.md).

#### Google / G-Suite (`src/connectors/google/`)

Gmail (search, get, send, mark-read), Docs (create, read), Sheets (read,
append), Drive (list files), Calendar (list events, create event), Tasks (list,
create). Full OAuth 2.0 with PKCE. Gmail trigger fires on incoming email matching
a per-workflow filter. 13 capabilities across trigger / step / delivery positions.

#### Airtable (`src/connectors/airtable/`)

Full CRUD on Airtable records (list, get, search, create, update, delete) plus a
webhook-based `airtable_record_changed` trigger. OAuth 2.0 + PKCE; workspace-level
install. Tokens auto-refresh (rotated on each refresh). Webhook subscriptions
persisted to `memory/airtable-webhooks.json`; HMAC-verified on every inbound event.
Required env: `AIRTABLE_CLIENT_ID`, `AIRTABLE_CLIENT_SECRET`.

#### Filesystem (`src/connectors/filesystem.js`)

Tenant-sandboxed file access for workflow steps. Two capabilities:

- **`filesystem_read`** — read a file and pass its content to the next step
- **`filesystem_list`** — list files/subdirectories in a folder

Security model: every call is sandboxed to the tenant's approved folders
(stored in `sources.json`). Only folders added server-side with an absolute path
are eligible — browser-upload entries (RAG-only) are skipped. The guard throws
on any path outside an approved root.

#### Web (`src/connectors/web/`)

Two capabilities (step position only):

- **`web_search`** — web search via Anthropic's native `web_search_20260209` tool. Ready when `ANTHROPIC_API_KEY` is set. Invoked through `llm.invoke()` using the same model tier already in use.
- **`web_fetch`** — fetches a URL and extracts readable article content using Mozilla Readability + jsdom (Firefox Reader Mode algorithm). Always ready; no API key required.

Shown as "connected" in the Connections flyout whenever `ANTHROPIC_API_KEY` is set. The converger surfaces both capabilities automatically from the CapabilityRegistry when the connector is available.

### Local models + RAG (`src/llm/`, `src/rag/`)

Open-source models locally via `node-llama-cpp`; cloud optional. Company-context
RAG with local GGUF embeddings + a per-tenant vector store.
See [`docs/capabilities/local-models-rag.md`](docs/capabilities/local-models-rag.md).

**RAG ingestion has two paths:**
- `POST /rag/index-folder` — server-side folder indexing (absolute path; makes
  the folder eligible for filesystem workflow access)
- `POST /rag/ingest-files` — browser upload (client reads `.md`/`.txt`/`.csv`,
  max 300 files / 200 KB each; RAG-only, no workflow filesystem access)

### Cloud inference (`src/llm/`)

`buildLLM()` prefers Anthropic (haiku fast / sonnet balanced+powerful) when
`ANTHROPIC_API_KEY` is set, falls back to OpenAI, then local GGUF weights.
`web_search` (via the Web connector) requires an Anthropic-backed tier (uses the native `web_search_20260209` tool).

### Converger (`src/converger/`, `src/graph/`)

Elicitation engine built on a custom `StateGraph` + HITL interrupt/resume loop.
Proposes one spec element at a time, checks against the live capability catalog,
logs every confirmation, and emits a runnable JSON spec. Gated against a frozen
canonical spec (`docs/specs/canonical-ups-slack.json`) for structural equivalence
and end-to-end runnability.

### Builder UI (`public/index.html`, `src/api/builder.js`)

Single-page conversational builder. The user describes what they want to automate;
the converger drives the dialogue, proposes steps, surfaces inline confirmations,
and publishes the finished workflow. Glassmorphic sidebar, flyout popovers
(Account, Connections), tutorial on first login, markdown rendering in chat.

### Console UI (`src/api/console.js`, `public/index.html`)

Per-workflow dashboard with live run history, per-step execution drawer
(inputs/outputs/timing/cost), success-rate metrics, pipeline DAG visualization,
pause/resume/run-now controls, and an SOP tab with one-click Markdown or PDF
export.

### SOP export (`src/workflows/sop-generator.js`, `src/workflows/sop-pdf.js`)

Generates a structured Standard Operating Procedure from a workflow spec:
trigger, step-by-step instructions, data-flow chain, dependencies. Rendered as
Markdown or a formatted PDF (pdfkit).

### In-app inbox (`src/connectors/inbox.js`)

`InboxStore` (SQLite, fail-closed tenant scoping) + `inbox_deliver` delivery
channel. Workflows can deliver to the in-app inbox alongside Slack. The UI
surfaces unread count + message list + mark-read / delete.

### Knowledge page (RAG + filesystem management)

Full-page UI section in the builder. Shows indexed sources as a filesystem tree
with expand/collapse. Users can connect folders two ways:

- **Browse for folder** — browser file picker (`<input webkitdirectory>`) reads
  file contents client-side and uploads to `/rag/ingest-files` (RAG only)
- **Server-side index** — `POST /rag/index-folder` with an absolute path (also
  makes the folder available to filesystem workflow steps)

### Scheduler (`src/workflows/workflow-scheduler.js`)

Supports full cron patterns (`0 9 * * 1-5`) plus sub-daily shortcuts
(`*/N * * * *` every N minutes, `0 */N * * *` every N hours). Tick is 60 s.
After all retry attempts fail, calls a registered `errorNotifier` — wired in
`server.js` to post to the Slack channel named in `error_handling.notify`.

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

**Always launch via `npm start`** (or `node --env-file=.env src/api/server.js`).
Running with bare `node` skips `.env`; `ANTHROPIC_API_KEY` goes unset and the
engine silently falls back to the local GGUF tier.

## HTTP surface

**Auth & setup** (unauthenticated or platform admin)
- `GET /health` — engine / auth / llm / rag / connector status
- `GET /setup/status`, `POST /setup` — first platform admin
- `POST /auth/login`, `POST /auth/logout`
- `GET|POST /tenants`, `POST /tenants/:id/users`, `POST /tenants/:id/status`
- `GET /users`

**User preferences** (auth required)
- `GET|PUT /api/user/preferences` — homepage module toggles

**Capabilities**
- `GET /capabilities` — per-tenant live capability catalog (triggers / steps / delivery)

**Workflow execution**
- `POST /workflows/run` — ad-hoc run with optional `initialContext`; returns 200
  with `{completed, error}` even on failure (Cloudflare-safe)

**Connector OAuth — Slack**
- `GET /connectors/slack/authorize`, `/callback`, `/status`, `DELETE /connectors/slack`
- `POST /connectors/slack/events` — Slack event webhook

**Connector OAuth — Google**
- `GET /connectors/google/authorize`, `/callback`, `/status`, `DELETE /connectors/google`
- `GET /connectors/google/capabilities`

**Web connector**
- `GET /connectors/web/status` — reports connected when `ANTHROPIC_API_KEY` is set

**Connector OAuth — Airtable**
- `GET /connectors/airtable/oauth/start`, `/callback`, `/status`, `DELETE /connectors/airtable`
- `POST /connectors/airtable/webhooks` — Airtable webhook registration
- `POST /connectors/airtable/events` — Airtable inbound webhook

**Google actions** (auth required)
- `POST /google/gmail/{search,get,send,mark-read}`
- `POST /google/docs/{create,read}`, `/sheets/{read,append}`
- `POST /google/drive/files`, `/calendar/{events,create}`, `/tasks/{list,create}`

**RAG & knowledge** (auth required)
- `POST /rag/ingest` — ingest text directly
- `POST /rag/query` — semantic search
- `GET /rag/sources` — list indexed sources for this tenant
- `POST /rag/index-folder` — server-side folder index (absolute path; enables workflow filesystem access)
- `POST /rag/ingest-files` — browser file upload (RAG only; max 300 files / 200 KB each)
- `DELETE /rag/sources` — remove a source by path

**In-app inbox** (auth required)
- `GET /inbox` — list messages
- `GET /inbox/:id` — message detail
- `PATCH /inbox/:id/read` — mark read
- `DELETE /inbox/:id` — delete

**Builder** (auth required)
- `GET /api/builder/me` — session hydration
- `POST /api/builder/chat` — converger turn
- `GET|POST /api/builder/workflows` — list + publish
- `GET|PUT|DELETE /api/builder/workflows/:id`
- `POST /api/builder/workflows/:id/restore`
- `GET /api/builder/workflows/deleted` — recently deleted
- `GET /api/builder/greeting` — AI home greeting
- `GET /api/builder/connections` — connector status
- `POST /api/builder/edit-intro` — AI opener for the edit flow (describes current workflow, invites changes)
- `POST /api/builder/edit-change` — apply a natural-language change request to an existing spec
- `GET /api/builder/home` — AI home greeting + recent workflow summary
- `GET /api/builder/mentions` — @-mention suggestions

**Console** (auth required)
- `GET /api/console/workflows` — tenant-scoped inventory
- `GET /api/console/workflows/:id/runs` — paginated run history
- `GET /api/console/workflows/:id/runs/:runId` — run detail with per-step data
- `POST /api/console/workflows/:id/run` — run now
- `POST /api/console/workflows/:id/pause`, `/resume`
- `GET /api/console/workflows/:id/sop` — SOP Markdown
- `GET /api/console/workflows/:id/sop/pdf` — SOP PDF download

**Interactions** (auth required)
- `GET /interactions` — converger session list
- `GET /interactions/:sessionId` — session transcript
- `GET /interactions/signals` — platform admin; converger signal log

## Verification & gates

Each phase has a fail-closed check in `scripts/gates/p<n>.sh`, run via
`scripts/gate.sh <n>`. A phase closes only when a fresh Verifier (which did not
write the code) passes the check and records `docs/gates/<gate>.md`. A
`pre-push` hook blocks publishing a `Gate:`-trailer commit unless its check passes.

```bash
bash scripts/gate.sh 8                       # P8: web connector + filesystem (20 checks)
bash scripts/gates/cap-multitenancy.sh       # cross-tenant isolation
bash scripts/gates/cap-slack-oauth.sh        # per-tenant Slack OAuth
```

## Repo layout

```
src/
  api/          server.js (spine) · builder.js · console.js
  workflows/    DAG executor · stores · scheduler · 12 node types · sop-generator · sop-pdf
  auth/         users · sessions · tenants · JWT · AES-256-GCM OAuth vault
  llm/          local (node-llama-cpp) + cloud models · ModelPool · cost tracker
  rag/          embeddings · per-tenant vector store · retrievers · ingestion
  connectors/   CapabilityRegistry · Slack · Google/G-Suite · Airtable · Filesystem · Web · Inbox
  converger/    elicitation engine · prompts · interaction store
  graph/        custom StateGraph · HITL interrupt/resume
  core/ utils/  shared primitives
public/         single-page builder + console + knowledge UI (index.html)
docs/           build plan · architecture · connector docs · gate ledgers · design mockups
scripts/gates/  per-phase + capability checks
memory/         airtable-webhooks.json · per-tenant vector stores (gitignored) · event log
```

## Build orientation

- **The plan:** [`docs/agntic-ops-gap-and-build-plan.md`](docs/agntic-ops-gap-and-build-plan.md) — gap map + sequenced phase plan.
- **Build constitution:** [`CLAUDE.md`](CLAUDE.md) — closed decisions, the don't-touch salvage list, multi-tenant conventions. Read first, every session.
- **Connector capabilities design:** [`docs/architecture/connector-capabilities.md`](docs/architecture/connector-capabilities.md)
- **Commit convention:** [`docs/COMMIT_CONVENTION.md`](docs/COMMIT_CONVENTION.md) — Conventional Commits + phase/gate tags, enforced by a `commit-msg` hook.

### Repo setup

```bash
git config core.hooksPath .githooks
git config commit.template .gitmessage
```

### Key env vars

| Var | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | Cloud inference + `web_search` connector (required for web search) |
| `OPENAI_API_KEY` | Fallback cloud inference |
| `AIRTABLE_CLIENT_ID` / `AIRTABLE_CLIENT_SECRET` | Airtable OAuth |
| `SLACK_CLIENT_ID` / `SLACK_CLIENT_SECRET` | Slack OAuth |
| `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` | Google OAuth |
| `OAUTH_REDIRECT_BASE` | Base URL for all OAuth callbacks (default: `http://localhost:3000`) |
| `AUTH_SECRET` | JWT signing secret |
| `OAUTH_KEY` | AES-256-GCM key for OAuth token encryption |
| `VECTOR_DIR` | Per-tenant RAG vector store root (default: `./memory/vectors`) |
| `WORKFLOWS_DB` | Workflow + run store (default: `./memory/atlas.sqlite`) |
| `INBOX_DB` | In-app inbox store (default: `./memory/inbox.sqlite`) |
