# Atlas

A conversational AI workflow builder by **Agntic**. Users build automations by
talking — the system proposes one step, the user confirms, it measures the gap to
a complete spec, and repeats until the workflow is finalized. Finished workflows
compile to a proprietary JSON spec that the execution engine runs and makes
observable.

The hard, unbuilt IP is the **converger** — the conversational elicitation engine
that turns a vague intent into that spec without ever proposing something the
wired connectors can't do. Everything shipped so far is the substrate it will be
built on.

## Status

| Phase | What | State |
|---|---|---|
| **P0** | Clean spine — execution engine + auth/credential vault boot in the new repo; `GET /health` | ✅ merged |
| **P1** | Slack connector — hand-authored spec posts to Slack; scope-aware capability map; per-tenant OAuth install | ✅ merged |
| — | **Multi-tenancy** — hard, fail-closed per-tenant data isolation (foundational) | ✅ merged |
| **P2** | Event triggers + Gmail — a UPS→Slack spec fires on a real email *(freeze the canonical spec)* | ▶ next |
| P3 | The **converger** (the IP) | planned |
| P4–P7 | Builder UI · console UI · launcher · third connector + reliability | planned |

Each ✅ was closed by an independent **Verifier** against a fail-closed gate; the
evidence lives in [`docs/gates/`](docs/gates/) and `git log --grep "^Gate:"`.

## What's built (the substrate)

- **Execution engine** (`src/workflows/`) — topological DAG executor with real
  inter-step data threading (`{{prev}}`, `{{nodeId.output}}`, transitive fan-in),
  11 node types, durable cost-tracked run logs. A local-model `ModelPool` is
  injected as the engine's LLM.
- **Auth + credential vault** (`src/auth/`) — argon2id passwords, revocable JWT
  sessions (with a tenant claim), AES-256-GCM-encrypted OAuth tokens. Every store
  is **tenant-scoped and fail-closed** (throws on a missing tenant — no silent
  unscoped reads).
- **Multi-tenancy** — each client is a tenant; users and all resources live under
  a `tenant_id`. Auth/vault/workflows use a shared DB with a bound scoping layer;
  **RAG is physically isolated per tenant** (its own store per tenant). One
  tenant's data can never surface in another's — proven by an adversarial suite.
  See [`docs/architecture/multi-tenancy.md`](docs/architecture/multi-tenancy.md).
- **Local models + RAG** (`src/llm/`, `src/rag/`) — run open-source models locally
  via `node-llama-cpp` (cloud providers optional), and company-context RAG with
  local GGUF embeddings + a per-tenant vector store. See
  [`docs/capabilities/local-models-rag.md`](docs/capabilities/local-models-rag.md).
- **Slack connector** (`src/connectors/slack/`) — a delivery channel
  (`chat.postMessage`) plus a full **OAuth install flow**: clients authorize the
  Atlas app ("Add to Slack"), the workspace token is stored encrypted per tenant,
  and an authenticated run posts as that tenant's workspace. A declarative,
  scope-aware **capability map** tells the converger exactly which Slack actions
  are usable for a given client. See [`docs/connectors/slack.md`](docs/connectors/slack.md).

> The per-subprocess **MCP runtime is intentionally deferred.** Connectors are
> currently direct-API + per-tenant OAuth (cheapest path that proves the spine);
> MCP gets re-homed only when a connector needs rich tool access.

## Running it

Requires **Node ≥ 22**. Native deps (`better-sqlite3`, `argon2`, `node-llama-cpp`)
build on install.

```bash
npm install
npm start            # boots the spine on :3000
curl localhost:3000/health
```

**Model weights are gitignored** (large GGUF binaries) and fetched out-of-band —
see [`docs/capabilities/local-models-rag.md`](docs/capabilities/local-models-rag.md)
for the embedding model + a chat model. The engine boots without them
(`llm:"unconfigured"` until present).

### HTTP surface (current)

- `GET /health` — status of engine / auth / llm / rag (unauthenticated).
- **Setup/auth:** `POST /setup` (first platform admin), `POST /auth/login`, `POST /auth/logout`.
- **Tenant management** (platform admin): `GET|POST /tenants`, `POST /tenants/:id/users`, `POST /tenants/:id/status`.
- **RAG** (per tenant, auth required): `POST /rag/ingest`, `POST /rag/query`.
- **Slack OAuth:** `GET /connectors/slack/authorize`, `GET /connectors/slack/callback`, `GET /connectors/slack/status`, `DELETE /connectors/slack`.
- **Capabilities / run:** `GET /capabilities` (per-tenant), `POST /workflows/run`.

## Verification & gates

Each phase has a fail-closed check in `scripts/gates/p<n>.sh`, run via
`scripts/gate.sh <n>`; capability deliverables have `scripts/gates/cap-*.sh`.
A phase closes only when a fresh Verifier (which did not write the code) passes
the check and records `docs/gates/<gate>.md`. A `pre-push` hook blocks publishing
a `Gate:`-trailer commit unless its check passes.

```bash
bash scripts/gates/p0.sh                 # spine boots, /health 200, clean UTF-8
bash scripts/gates/cap-multitenancy.sh   # cross-tenant isolation (auth/vault/workflows/RAG/HTTP)
bash scripts/gates/cap-slack-oauth.sh    # per-tenant Slack OAuth install + post
```

## Repo layout

```
src/
  api/         minimal HTTP spine (server.js) — grows per phase
  workflows/   execution engine (DAG executor, stores, scheduler, node types)
  auth/        users, sessions, tenants, JWT, AES-256-GCM OAuth vault
  llm/         local (node-llama-cpp) + cloud models, ModelPool, cost tracker
  rag/         embeddings + per-tenant vector store, retrievers, ingestion
  connectors/  Slack (channel + OAuth) + connector manifest
  graph/       custom StateGraph + HITL interrupt/resume (converger substrate)
  core/ utils/ memory/   shared primitives
docs/          build plan, architecture, connector + capability docs, gate ledgers
scripts/gates/ per-phase + capability checks   ·   scripts/checks/ their harnesses
```

## Build orientation

- **The plan:** [`docs/agntic-ops-gap-and-build-plan.md`](docs/agntic-ops-gap-and-build-plan.md) — gap map + sequenced Phase 0–7 plan.
- **Build constitution:** [`CLAUDE.md`](CLAUDE.md) — closed decisions, the don't-touch salvage list, the multi-tenant + frozen-spec conventions. Read first, every session.
- **Commit convention:** [`docs/COMMIT_CONVENTION.md`](docs/COMMIT_CONVENTION.md) — Conventional Commits + phase/gate tags, enforced by a `commit-msg` hook.

### Repo setup

This repo enforces its commit pattern with local hooks. After cloning:

```bash
git config core.hooksPath .githooks
git config commit.template .gitmessage
```
