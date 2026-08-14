# Salvage map — `agntic-prod` → Atlas

Grounding for migration. Built by read-only scouts against `~/Desktop/agntic-prod`
on 2026-06-08. **Line numbers are non-authoritative provenance** (per ENGINEERING-LOG.md
working rules) — they were live-correct when written; re-ground before relying on
an exact coordinate. The invariants and entry points are the contract.

The salvage repo is `agntic` v4.9.3 (`package.json`), ESM, Node. Native deps that
need a rebuild after `npm install` on a new machine: **`better-sqlite3`**, **`argon2`**.
No `@modelcontextprotocol/sdk` dep — the MCP wire protocol is hand-implemented.

## The four salvage subsystems

The tree is cleanly layered. `src/graph/` and `src/auth/` are fully self-contained
(zero upward deps). `src/agents/` sits on top and imports nearly everything.

### 1. Execution engine — `src/workflows/` (best-built part)

- **DAG executor**: `FlowTester.run(flow, opts)` — `flow-tester.js:60`. Async generator
  yielding `run_started`/`step_started`/`step_completed`/`step_failed`/`run_completed`/`run_failed`.
- **Dispatch**: `WorkflowScheduler.runNow(workflowId, {trigger, sessionId})` — `workflow-scheduler.js:218`.
- **Public CRUD**: `WorkflowService` — `workflow-service.js:236` (all mutations route here).
- **The proprietary spec format** (the thing Atlas keeps — no BPMN port):
  `{ name, description, triggers[], nodes[], edges[], errorHandling }`.
  - Node: `{ id, type, label, config }`. Edge: `{ from, to }`.
  - SQLite schema: `workflow-store.js:20-72` (`workflows`, `workflow_runs`, `workflow_versions`;
    `triggers`/`nodes`/`edges`/`error_handling` stored as JSON strings).
  - Recipe→spec assembly: `workflow-service.js:254-324` (`_assembleDefinition`).
- **Data threading** — all in `flow-tester.js`:
  - `{{prev}}` → `ctx.lastOutput` (`:250`, updated `:133`)
  - `{{nodeId.output}}` → `ctx.outputs` Map (`:251-253`)
  - transitive fan-in → `ancestorsOf()` DFS over reverse adjacency (`:73-90`),
    consumed by transform nodes via `node-types/_node-input.js:58+`.
- **11 node types** (`node-types/index.js:21-39`): `trigger`, `deliver`, `search_web`,
  `summarize`, `rewrite`, `extract`, `daily_digest`, `fetch`, `tool`, `mcp_tool`, `llm`.
- **Run logs / cost**: durable in SQLite `workflow_runs` (`workflow-store.js:505-575`,
  cols incl. `tokens_in/out`, `cost_usd`, `llm_calls`, `steps` JSON). Unified outputs log
  via `MetricsStore` (`observability/metrics-store.js:196`, `memory/metrics.sqlite`).
  `CostTracker` (`llm/cost-tracker.js:35`) attributes cost per `flow-run-<runId>` / per node.
- **Injected (not imported), duck-typed**: an LLM with `.invoke()`, a `ToolRegistry`,
  a `ChannelRegistry`. → Atlas just passes compatible objects.
- **Hard internal imports to bring along**: `core/message.js` (5 node types need
  `SystemMessage`/`HumanMessage`), `llm/native-citations.js` (`search_web` only),
  `llm/cost-tracker.js`, `observability/metrics-store.js` (optional — guarded), `utils/logger.js`.

### 2. Agent core — `src/graph/` + `src/agents/` (substrate for the converger)

- **Custom `StateGraph`** (not LangGraph): `graph/state-graph.js:19`. Builder:
  `addNode :79`, `addEdge :98`, `addConditionalEdges :126`, `setEntryPoint :143`,
  `compile :182` → `CompiledGraph` (accepts `checkpointer`, `interruptBefore/After`).
- **ReAct loop**: the `agent → tools → check_tools → agent` cycle in
  `agents/agent-graph.js:447-483`. `ToolCallingAgent` — `tool-calling-agent.js:48`.
- **Two-phase parallel planning**: Phase 1 = `PlanningAgent.generatePlan()`
  (`planning-agent.js:63`, one LLM call w/ `write_todos`) + HITL gate. Phase 2 =
  `topoSort()` (`agent-graph.js:3328`) → waves fanned out via `Send[]` to `task_worker` nodes.
- **HITL pause — THE pattern for the converger** ("propose step → confirm → continue"):
  - `interrupt(payload)` (`graph/interrupt.js:120`, uses `AsyncLocalStorage`) throws a
    `GraphInterruptSignal`; `CompiledGraph._runLoop` catches at `compiled-graph.js:345`,
    checkpoints with `resumeFrom`, re-throws as `GraphInterrupt`.
  - Live example: `_planningNode` calls `interrupt({plan, tasks})` at `agent-graph.js:1199`.
  - **Resume**: `graph.resume(threadId, new Command({resume: value}))` (`agent-graph.js:2085`
    → `compiled-graph.js:465`); on re-run `interrupt()` *returns* the decision instead of throwing.
  - Requires a checkpointer. Currently `MemoryCheckpointer` (`agent-graph.js:504`, ephemeral).
    `FileCheckpointer` (`checkpointer/file-checkpointer.js:19`, JSONL, survives restart) exists
    but is unwired — **swap to it if the converger loop must survive a restart** (config change,
    identical interface).
- **Coupling risk**: `agent-graph.js` is a 3,429-line monolith; the planning/wave subgraph
  is entangled with all other nodes. `topoSort` is private (`:3328`). `PlanningAgent` and the
  whole `src/graph/` layer migrate cleanly as units.

### 3. MCP connector runtime — `src/mcp/` + `src/connectors/`

- **Per-user isolation**: `PerUserMcpPool` (`per-user-mcp-pool.js`) keeps one `McpManager`
  per `userId` (`:51`); user-scoped servers (`source='user'`, `owner_user_id≠''`) route only to
  the owner's pool, never the shared manager (`:6-17`, `:110-129`). Fail-closed gate in
  `server.js:944-983`. Token injected per-user via `_injectToken` (`:136-155`). Idle reap 15 min.
- **Subprocess**: `McpClient` spawns stdio child processes; wire protocol hand-implemented
  (`mcp-client.js:8`, no SDK dep).
- **Manifest = config-only connector adds**: `connectors/connector-manifest.js`. Entry shape
  `{ id, label, icon, description, oauth:{connectorId,scopes[],provider?}, mcp:{transport,commandEnv,argsEnv,env,toolsAllowlistEnv} }`
  (`:28-39`). `materializeMcpDef()` (`:190-207`) builds the registry def at OAuth-callback time.
  "Connector #N is a config edit" is real (`:7-9`).
- **Existing connectors**: `google` (Gmail+Calendar+Drive, read-only; MCP binary is a
  `GOOGLE_MCP_ARGS` placeholder — must be set before P2) and `github`. **No Slack connector**
  → P1 builds one from scratch. **Gmail is bundled inside `google`** → P2 uses that entry.
- **Isolation tests**: `tests/cross-user-mcp-isolation.test.js` (7 tests, 2 layers — store-level +
  real-subprocess end-to-end with per-user token-injection / no-bleed assertions). Stand-in server:
  `tests/fixtures/standin-mcp-server.mjs`.
- **Tool exposure**: `McpToolAdapter extends BaseTool` (namespaced `server__tool`); built-ins win
  collisions. Composed turn-scoped via `toolRegistry.overlay(userTools)` (`tool-registry.js:115-122`)
  — never mutates shared state.

### 4. Auth + credential vault — `src/auth/`

- **Entry**: `createAuthSubsystem` (`auth/index.js`); routes `POST /setup`, `/auth/login`,
  `/auth/logout`, `/auth/change-password`, session list/revoke. Middleware
  `buildAuthMiddleware` (`middleware.js:25`) → `requireAuth`/`requireAdmin`/`optionalAuth`.
- **Passwords**: argon2id, OWASP-2024 params (`user-store.js:14,33-38`); verify + on-demand
  rehash (`:135-140`).
- **JWT sessions**: `TokenService.sign` HS256 `{sub,jti,role}` (`token-service.js:81`).
  **Revocation**: `sessions.revoked_at` column; `revoke`/`revokeAllForUser`
  (`session-store.js:117,128`); every request `touch(jti)` rejects revoked tokens
  (`middleware.js:52`, `session-store.js:109`). Store: `memory/auth.sqlite`.
- **OAuth vault**: AES-256-GCM, wire format `v1:<b64url(iv|tag|ct)>` (`token-cipher.js:17,38,53`).
  Key resolution `OAUTH_TOKEN_KEY` env → `memory/.oauth-key` (chmod 600) → generate
  (`oauth-key.js:44`). Ciphertext only in `oauth_tokens` (`memory/oauth.sqlite`,
  PK `(user_id, connector_id)`); plaintext never crosses the store boundary.
- **Per-user scoping**: every table keyed by `user_id`; routes pass `req.user.id` explicitly.

## Boot path & the encoding gotcha

- Entry: `src/api/server.js` → `start()` at `:641`, `app.listen(PORT)` (default 3000) at `:4095`.
- **`/health` is at `server.js:3352`** — unauthenticated, returns
  `{status, uptime, sessions, rag, inference, monitor}` (+ optional `mcp`/`profile`). **This is the P0 health route.**
- **ENCODING GOTCHA (corrected & precise)**: `src/api/server.js` is **valid UTF-8**, *not*
  UTF-16 and has *no BOM*. It contains a single literal NUL byte (`\x00`) at **offset 20198**,
  inside a session-key template string `u:${userId}\x00${rawSessionId}`. That one NUL makes
  `file` report `data` and macOS `grep` (plain) stop early → "zero matches" illusion. Verified:
  `grep -c express` → 0 / exit 1; `grep -ac express` → 4; `head -c4 | xxd` → `2f2a 2a0a` (`/**\n`).
  **Fix on migration = replace/remove that one NUL byte, then it's clean UTF-8.** (Atlas P0 builds
  a *new* minimal server.js anyway — see below — so this matters only if/when copying logic out of it.)

## P0 migration plan — THIN SPINE (decision recorded 2026-06-08)

Decision: **thin spine, grow as needed.** Do *not* port `server.js` whole (it drags in RAG +
llama.cpp inference + model-pool + mcp that P0 doesn't exercise). Add those subsystems in the
phases that need them.

**Bring across for P0:**
- `src/core/` (esp. `message.js`) · `src/utils/` (`logger.js`, `errors.js`)
- `src/graph/` (self-contained converger substrate)
- `src/workflows/` (the engine: flow-tester, workflow-store, -scheduler, -service, validator,
  `node-types/`, `sources/`) + its hard deps `llm/cost-tracker.js`, `llm/native-citations.js`,
  `observability/metrics-store.js`
- `src/auth/` (login + vault)
- **A new minimal `src/api/server.js`** that mounts only what P0 needs and exposes `GET /health`.

**Defer to later phases**: `src/agents/agent-graph.js` (the monolith — extract the converger pieces
in P3/P4, don't bulk-port), `src/mcp/` + `src/connectors/` (P1 Slack), `src/conversations/`,
`src/artifacts/`, most of `src/memory/`.

> **Pulled forward (decision 2026-06-08):** `src/rag/` and `src/llm/llama-cpp-llm.js` +
> `model-pool.js` (local inference) were originally deferred here but are now migrated —
> the product needs local open-source models + company-context RAG. Also brought:
> `src/llm/{chat-model.js, cost-tracker.js}` and `src/memory/{stores.js, base-store.js}`
> (RAG's only `memory/` reach-in). See
> [`docs/capabilities/local-models-rag.md`](capabilities/local-models-rag.md).

**P0 "Done when" (per `scripts/gates/p0.sh`)**: server boots; `curl /health` → 200 with expected
payload; the migrated `server.js` is clean UTF-8 (no NUL/encoding that breaks plain `grep`).
Note: a thin-spine `/health` need not report `rag`/`inference` — trim the payload to what's wired.
