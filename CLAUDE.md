# Atlas — Build Constitution

Read this first, every session. It encodes the decisions that are **closed**, the
code that is **off-limits**, and the rules that keep agents from reasoning over
stale state. If something here is wrong, fix *this file* in the same commit —
don't work around it.

Full context: [`docs/agntic-ops-gap-and-build-plan.md`](docs/agntic-ops-gap-and-build-plan.md).
Commit rules: [`docs/COMMIT_CONVENTION.md`](docs/COMMIT_CONVENTION.md).

## What Atlas is

A conversational workflow builder. The system starts from a vague intent and
closes the gap through dialogue — propose one step, user confirms, measure the
distance to a complete spec, repeat — then emits a JSON spec the existing engine
executes. The hard, unbuilt IP is that **converger**.

## Closed decisions (do not re-litigate)

- **Keep the proprietary JSON spec format.** No BPMN/DMN port.
- **The codebase is workflow-agnostic** *(2026-06-18)*. It is a general engine for building
  and running ANY workflow — it is NOT built around the canonical UPS→Slack example. That
  spec (`docs/specs/canonical-ups-slack.json`) is a **test fixture** for the P2/P3 gates,
  nothing more. Mechanisms must be generic: token injection (`injectTenantTokens`), the
  capability catalog, execution, and the converger all work for arbitrary node/connector/
  trigger combinations. Never special-case logic to one workflow shape; add a generic branch
  (e.g. per-connector) instead.
- **Connectors are a unified, real-time, position-agnostic capability catalog**
  *(direction approved 2026-06-18)*. Each connector exposes ONE catalog; each capability
  declares which positions it can occupy (**trigger / step / delivery**), its required
  scopes, and **real-time availability** from the tenant's *granted* scopes. The converger,
  engine, and UI all read the same catalog, so any connected connector can be used anywhere
  in a workflow. This replaces today's fragmentation (channelRegistry = delivery only;
  no ToolRegistry so steps are dead; only email/schedule triggers). It is the substrate for
  P7/P8 — design-first, built in increments (unify catalog → enable connector *steps* via
  existing handlers → converger consumes positioned catalog → connector-event triggers).
  Design: [`docs/architecture/connector-capabilities.md`](docs/architecture/connector-capabilities.md).
- **Multi-tenant from the foundation** *(reverses the earlier "no tenancy in
  pilot" decision, 2026-06-09).* Each onboarding client gets a `tenant_id`; users
  and every resource live underneath it. Data isolation is **hard and fail-closed**
  — one tenant's data never surfaces in another's, enforced structurally (stores
  throw on a missing tenant, never silently return all rows) and proven by
  adversarial cross-tenant tests. Auth/workflows/vault use a **shared DB with a
  bound tenant-scoping layer**; **RAG is physically isolated per tenant** (each
  tenant has its own RAG datastore/connector — cross-tenant retrieval is impossible,
  not just filtered). See [`docs/architecture/multi-tenancy.md`](docs/architecture/multi-tenancy.md).
- **All UI is built fresh.** No reuse of the dormant in-chat builder or the old
  console. Clean design language, no entanglement.
- **Fresh private repo** (this one), migrating salvage from `agntic-prod`. The
  old repo is a read-only archive.

## Don't touch (salvage — solid, high quality)

These are the expensive, correct parts. Read them, build *against* them, do not
refactor them without an explicit decision recorded here:

- **Agent core** — compiled `StateGraph`, ReAct tool loop, two-phase parallel
  planning, one human-in-the-loop pause. This is the substrate for the converger.
- **Execution engine** — topological DAG executor with real inter-step data
  threading (`{{prev}}`, `{{nodeId.output}}`, transitive fan-in), durable
  cost-tracked run logs. Best-built part of the codebase.
- **MCP connector runtime** — per-user subprocess isolation, isolation-tested,
  manifest-driven (connector #N is a config edit).
- **Auth + credential vault** — argon2id, revocable JWT sessions,
  AES-256-GCM-encrypted OAuth tokens, per-user store scoping.
- **RAG + local inference** (migrated 2026-06-08, pulled forward from the deferred
  list) — `src/rag/` + `src/llm/{llama-cpp-llm,model-pool,chat-model}.js`. Local
  open-source models via node-llama-cpp + company-context RAG. See
  [`docs/capabilities/local-models-rag.md`](docs/capabilities/local-models-rag.md).

**Recorded salvage edits** (the only intentional changes to salvage code):
- **Password reset (2026-07-06)** — `src/auth/index.js` `createAuthSubsystem` now also
  instantiates a `PasswordResetStore` (new `src/auth/password-reset-store.js`) on the
  shared auth DB and exposes it as `spine.auth.passwordResetStore`. Purely additive — no
  change to existing auth logic. Powers the self-service reset flow (`/auth/forgot`,
  `/auth/reset/verify`, `/auth/reset` in `server.js`) + `src/utils/mailer.js` (SMTP via
  nodemailer, dev-fallback logs when unconfigured). Tokens are stored **hashed** (SHA-256),
  single-use, 30-min TTL; reset consumes the token, sets the password via the existing
  `changePassword({oldPassword:null})` path, and `revokeAllForUser`. Email is globally
  unique so `findByEmail` resolves one user; `/auth/forgot` is anti-enumeration + throttled.
- `src/rag/embedding-model.js` — local-embedding `getLlama({gpu})` was hardcoded
  `false`; made configurable (default `'auto'`, `LLAMA_GPU` to override). Hardcoded
  `false` broke on Metal-only node-llama-cpp prebuilts (Apple Silicon). 2026-06-08.
- **Multi-tenancy (2026-06-09)** — the salvage stores are scoped by `user_id`;
  tenancy adds `tenant_id` as the dominant scope. Approved edits: schema +
  fail-closed scoping in `src/auth/{user-store,session-store,oauth-token-store}.js`,
  `src/workflows/{workflow-store,feedback-store}.js`, JWT/middleware in
  `src/auth/{token-service,middleware,index}.js`, and per-tenant RAG resolution in
  `src/api/server.js`. Stores now **throw** on a missing tenant rather than
  returning unscoped rows. See [`docs/architecture/multi-tenancy.md`](docs/architecture/multi-tenancy.md).
- **compiled-graph.js resume-value consumption (2026-06-12)** — `src/graph/compiled-graph.js`
  `_runLoop`: `resumeValues[currentNode]` was never cleared after use. Every subsequent call
  to the same node name within one `_runLoop` (e.g. `clarify → analyze → clarify`) received
  stale resume values and `interrupt()` returned immediately instead of pausing, causing
  infinite loops up to the recursion limit. Fix: `delete resumeValues[currentNode]` after
  building the `InterruptContext` (one line, no behavior change for single-visit nodes).
- **Cloud inference (2026-06-12)** — `src/api/server.js` `buildLocalLLM()` replaced
  with `buildLLM()`: prefers Anthropic (claude-haiku fast / claude-sonnet balanced+powerful)
  when `ANTHROPIC_API_KEY` is set, falls back to OpenAI, then local weights. `ChatModel`
  import added. Startup log now reflects actual provider. No logic changes to engine or
  salvage LLM modules.
- **Converger spec → persistence bridge (2026-06-17, P4)** — persisting a converger
  (or the frozen canonical) spec via `workflowService.create` failed validation; **the
  frozen canonical spec itself failed identically**, so this was a pre-existing
  validator/persistence defect surfaced by P4 (the first path to persist a converger spec).
  Two engine-layer fixes (Option Z, decided with the user):
  1. `src/workflows/workflow-validator.js` — `MISSING_TRIGGER` now accepts a trigger in
     the top-level `triggers[]` array (what the scheduler reads, and what the converger /
     canonical spec emit), not only a `type:'trigger'` **node**. Demanding a trigger node
     wrongly rejected runnable event/email specs. *Verified*: synthesizing a trigger node
     instead is wrong — its `{trigger:true}` sentinel clobbers the entry node's seeded
     input, making summarize summarize the sentinel (the entry step is seeded from the
     trigger event via `initialContext`, with no trigger node).
  2. `src/workflows/workflow-service.js` — `create()`'s pre-built branch now fills missing
     **required** node config from each node-type's schema `default` (`_applyConfigDefaults`),
     e.g. summarize `length:'medium'` / `style:'neutral'` — the same values the executor
     already applies at runtime. Non-mutating.
  Also `src/api/server.js` `POST /workflows/run` accepts an optional `initialContext`
  (sample event) so the builder's "Run test" can fire trigger-based flows end-to-end. P2/P3
  gates still pass.
- **Console run-query tenantId scoping (2026-06-18, P5)** — `getRuns(workflowId, limit, opts)` and
  `getRun(runId, opts)` in `src/workflows/workflow-store.js` previously only accepted `userId` in
  the opts object; `tenantId` was absent, making cross-tenant isolation impossible for run reads.
  Both methods now accept `tenantId` and include it in the WHERE clause when provided. Every P5
  console endpoint passes `req.tenant.id` + `req.user.id` to enforce both dimensions. The fix
  uses the same WHERE-builder pattern already used by `list()`. Non-breaking for existing callers
  that pass only `userId` or neither.
- **Builder tenantId + status on publish (2026-06-19)** — `POST /api/builder/workflows` called
  `workflowService.create()` with only `{ userId }`, no `tenantId`. The store's `create()` falls
  back to `tenant_id: 'default'` when no tenantId is given, so all published workflows were
  invisible to the console (which queries by the real tenant id). Additionally the non-recipe
  (`_assembleDefinition`) path defaulted to `status: 'draft'`, so scheduled workflows were never
  picked up by the scheduler. Fixes: `workflow-service.js` `create()` now accepts `tenantId` in
  its opts and passes it to the store; `builder.js` passes `tenantId: req.tenant.id` and adds
  `status: 'active'` to the spec before calling create. Existing `tenant_id='default'` rows were
  migrated to the real tenant id in a one-time SQL update.
- **OAuth redirect base centralized (2026-06-18, P4)** — `OAUTH_REDIRECT_BASE` is now the
  single lever for where every connector's OAuth redirects back. New helper
  `src/connectors/oauth-redirect.js` (`oauthRedirectBase()` / `connectorRedirectUri()`,
  PORT-aware localhost default). `src/connectors/slack/oauth.js` previously read only
  `SLACK_REDIRECT_URI` and ignored the base — now derives `<base>/connectors/slack/callback`
  (explicit var still overrides). `src/auth/oauth-client.js` (Google) routes its existing
  base derivation through the shared helper. `.env` per-connector `*_REDIRECT_URI` overrides
  commented out so the base drives both. Whatever base is chosen must be registered as an
  allowed redirect URL in the provider consoles. (Surfaced by a Cloudflare Tunnel 1033 on the
  hosted base while testing locally; prod hosting is P11.)
- **CapabilityRegistry + unified catalog (2026-06-20, P7)** — new
  `src/connectors/capability-registry.js` replaces the fragmented ChannelRegistry / per-connector
  silos with a single position-agnostic catalog. Each capability declares `positions: ['trigger'
  | 'step' | 'delivery']`, `isReady()`, and a `handle` (none for triggers). `ChannelRegistry`
  now wraps `CapabilityRegistry` (adapter pattern): `getAll()` returns step+delivery only
  (no triggers). `buildEngine()` in server.js instantiates `CapabilityRegistry` first, passes it
  to `ChannelRegistry`, then calls `registerSlackTriggers`, `registerGoogleChannels`,
  `registerAirtableChannels`. The `/capabilities` endpoint + builder session creation narrow
  trigger `available` flags per-tenant based on actual connector connection status.
- **Airtable connector (2026-06-20, P7)** — `src/connectors/airtable/index.js` (CRUD + webhooks)
  + `src/connectors/airtable/oauth.js` (OAuth 2.0 + PKCE auth). OAuth install is workspace-level:
  `wsinstall:<tenantId>` synthetic userId, mirrors Slack bot token pattern. Access tokens expire
  in 3600s; refresh tokens are rotated on each refresh (`_doRefresh` persists new refresh token
  immediately). `getAirtableAccessToken` (async, auto-refresh) used in all async server paths;
  `getAirtableToken` (sync, no refresh) used by `injectTenantTokens`. OAuth routes:
  `GET /connectors/airtable/oauth/start` → Airtable consent screen;
  `GET /connectors/airtable/callback` → exchange code, store tokens, redirect to `/?connected=airtable`.
  7 capabilities: list/get/search/create/update/delete records + `airtable_record_changed` trigger.
  Real webhook subscriptions via Airtable Webhooks API; HMAC-verified (`X-Airtable-Content-MAC`).
  Webhook routing table persisted to `./memory/airtable-webhooks.json` (Map rebuilt on start).
  Required env: `AIRTABLE_CLIENT_ID`, `AIRTABLE_CLIENT_SECRET` (from airtable.com/create/oauth).
- **Google write-back capabilities (2026-06-20, P7)** — `registerGoogleChannels` in
  `src/connectors/google/index.js` adds 13 capabilities to the catalog (8 step-only reads,
  5 step+delivery writes, 1 gmail trigger). `makeGoogleApiFromToken(token)` added for credential
  injection via `CONNECTOR_INJECTORS`. All handles use `config.googleToken` injected at run time.
- **Sub-daily scheduling (2026-06-20, P7)** — `_isFlowDue` in `src/workflows/workflow-store.js`
  now supports `*/N * * * *` (every N minutes) and `0 */N * * *` (every N hours) cron patterns.
  Sub-daily patterns use elapsed-time deduplication (`Date.now() - last_run >= intervalMs`) instead
  of the per-calendar-day check used by daily/weekly patterns. Scheduler tick is 60s — sufficient
  for minute-level granularity.
- **Error handling with retry + notify (2026-06-20, P7)** — `WorkflowScheduler._executeFlow` in
  `src/workflows/workflow-scheduler.js` is now a retry wrapper: reads
  `workflow.error_handling.retry.attempts` (extra attempts) and `retry.delay_seconds` (wait between
  attempts), then delegates to `_runFlowOnce` (the extracted single-attempt executor). After all
  attempts fail, calls `this._errorNotifier(workflow, error)` if registered.
  `registerErrorNotifier(fn)` added. In server.js, a Slack-based notifier is wired: reads
  `workflow.error_handling.notify.{type:'slack', channel}`, resolves the tenant's bot token from
  the grant store (falls back to `SLACK_BOT_TOKEN`), and posts to the specified channel.
- **Filesystem connector (2026-06-21, P8)** — `src/connectors/filesystem.js` registers
  `filesystem_read` and `filesystem_list` capabilities (step position) in the CapabilityRegistry.
  Both are sandboxed to the tenant's approved folders (entries with absolute paths in
  `sources.json` — browser-upload entries are RAG-only). `injectFilesystemContext()` in
  `server.js` stamps `_tenantId` into connector-action node configs before each run, mirroring
  the `injectInboxContext` pattern. Called in all four run paths: REST `/workflows/run`,
  scheduler token injector, Slack event dispatch, Airtable event dispatch. Only absolute-path
  entries (added server-side via `/rag/index-folder`) are eligible for workflow file access;
  browser-upload entries (`source:'upload'`) have no stable server path and cannot be used.
- **search_web in converger prompt (2026-06-21, P8)** — `src/converger/prompts.js` listed
  `search_web` as an available node type (Anthropic native web_search_20260209). Later superseded
  by the Web connector (see below); entry removed from prompts.js.
- **Web connector (2026-06-21, post-P8)** — `src/connectors/web/index.js` registers
  `web_search` and `web_fetch` capabilities (positions: `['step']`) in the CapabilityRegistry.
  No Tavily or Firecrawl — fully self-owned:
  - `web_search`: Anthropic native `web_search_20260209` via the LLM service (same model tier
    already in use). `isReady()` = `ANTHROPIC_API_KEY` is set. Connected = Anthropic key present.
  - `web_fetch`: Mozilla Readability + jsdom (deps added). Fetches a URL and extracts readable
    article content (Firefox Reader Mode algorithm). `isReady()` = always true (no API key).
  `registerWebCapabilities(registry, { llm })` takes the LLM service so `web_search` can call
  through `llm.invoke()`. Registered in `bootSpine` after filesystem capabilities.
  `webConnectionStatus()` returns `{ connected: !!ANTHROPIC_API_KEY, anthropic, detail }`.
  UI: Connections flyout fetches `/connectors/web/status`; shows Web as connected when
  ANTHROPIC_API_KEY is set. Chat context (`builder.js`) surfaces web capability when connected.
  The old `search_web` built-in node type remains but is no longer promoted to the converger;
  `web_search` connector-action is the primary path.

- **Node library re-cut + `UNKNOWN_CONFIG_KEY` (2026-07-13, P12 increment A)** — the node library
  had eleven types; three could never run and four were `llm.js` with a different prompt. It is now
  **`trigger · llm · assemble · connector-action · search_web · deliver`**.
  - `src/workflows/node-types/llm.js` gains **`mode: summarize|extract|rewrite|classify|freeform`**
    and absorbs the prompts of the types it replaces. `summarize.js`, `extract.js`, `rewrite.js`,
    `tool.js`, `mcp-tool.js`, `fetch.js` **deleted**. `daily-digest.js` → **`assemble.js`**: it was
    *not* an LLM node (its `run()` took `(cfg, _ctx, _services)` and never called the model), so
    collapsing it into `llm` would have turned free, deterministic string assembly into a paid
    model call. Renamed, behaviour identical.
  - **`classify`** is new and load-bearing for increment C: it is the only sanctioned way for an
    LLM to feed a decision, because it classifies into a **closed enum** and throws on an off-enum
    answer instead of passing free text downstream.
  - **`src/workflows/node-types/compat-v1.js`** (new) — `liftV1Node()` maps the old types to the
    new ones. Called from **exactly two** places: `WorkflowValidator.validate()` and
    `FlowTester._runNode()` (the scheduler and the REST run path both execute through FlowTester).
    **No DB migration**: v1 specs are lifted on read, never rewritten on disk.
  - `src/workflows/workflow-validator.js` — new **`UNKNOWN_CONFIG_KEY`** (a config key not in the
    type's `configSchema` is an error, not a shrug), `REMOVED_NODE_TYPE`, `UNKNOWN_LLM_MODE`. The
    dead `fetch`/`tool`/`mcp_tool` branches of `_checkTypeSpecific` are gone.
  - **`UNKNOWN_CONFIG_KEY` is scoped by a new `configPolicy` on each node type** (`'closed'` by
    default; `connector-action` is the only `'open'` one, because its params are per-capability).
    A blanket subset check was **impossible**: it rejects the frozen canonical spec (whose
    `summarize` node carries `instructions`/`format`, which the v1 schema never declared) and the
    ordinary Slack/Gmail delivery shapes. Keys the handlers genuinely read
    (`deliver.target|user|to|subject|username|icon_emoji`, `search_web.query`) are now **declared**,
    because the schemas were lying — a key no code reads (`llm.model`) is a hallucination and
    errors; a key a handler reads but the schema omitted is an untrue schema and gets fixed.
    **Never declare a key `run()` doesn't consume, and prove the consumer with a word-boundary grep
    before you declare it.** Increment A briefly declared `deliver.message` on a misread (a grep for
    `config.message` **prefix-matched `config.messageId`**, a `gmail_get_message` param); the
    independent verifier caught it. Nothing reads `config.message`, so such a deliver node has its
    content **silently dropped** at run time — defect #3, re-created inside the check built to kill
    it. It is rejected, and pinned by a test.
  - `scripts/gates/p12.sh` — `run_test()` now runs `node --env-file-if-exists=.env --test` **and
    fails closed on any skipped test**. It previously ran the E2E with no env file, so the gate's
    own regression step hit the self-skip trap: `tests/e2e/full-journey.test.js` skips its converger
    test without `ANTHROPIC_API_KEY` and still reports a cheerful "6 pass / 1 skip" — the skipped
    one being the thing under test. The gate was passing itself on a suite that had quietly not
    tested the converger. *(Making a check stricter, not weaker — CLAUDE.md, Gates.)*
  - `src/converger/prompts.js` — **the actual root cause of the `model` hallucination**: the prompt
    advertised `llm: (config: prompt, model)`, i.e. it *told* the model to emit a key no schema
    had. Now it teaches `llm` + `mode` with the closed key set, and states that `model` does not
    exist. The converger emits v2 nodes natively (verified against the live LLM).
  - `scripts/checks/p3-converger-run.mjs` — asked `n.type === 'summarize'`. That asks about an
    *encoding*, and the encoding changed; P3 actually asserts a *role*. Now checks
    `llm` + `mode:'summarize'` **via the same lift**, so both spellings satisfy it. Not weaker: a
    spec with no summarizing step still fails. *(Fixing the check, not weakening it — CLAUDE.md,
    Gates.)*
  - Also updated for the re-cut: `sop-generator.js` (mode-aware labels — an SOP is customer-facing,
    so a step that read "Summarize (LLM)" must not start reading "AI step"), `run-enricher.js`,
    `output-validator.js`, `workflow-scheduler.js` (`_collectToolsUsed` read only the two deleted
    types, so it would have returned `null` forever — it counts `connector-action` capability ids
    now), `error-translator.js`, and `public/index.html` (one `effNodeType()` helper so an
    `llm`+`mode` node still renders as a "Summarize"/"Extract" card, not a generic λ).
  - **Fixed in passing:** `flow-tester.js` tested `node.type === 'search-web'` (hyphen) for the
    long-timeout path, but the registered id is `search_web` — so every web-search step had been
    silently getting the *short* timeout.

- **Engine control flow (2026-07-13, P12 increment B)** — the engine could only run a DAG
  straight through: no conditionals, no loops, no pause, no retry, no dedupe. It now has all five.
  New node types `branch` / `foreach` / `human` (`src/workflows/node-types/`), plus two node-level
  attributes, `on_error` and `idempotency`. `decision` is increment E; `wait` is unbuilt.
  - **Liveness is tracked on EDGES, not nodes** — `src/workflows/flow-tester.js`. An edge goes
    live when its source completes; out of a `branch`, only the selected case's edge does. A node
    is skipped iff it has incoming edges and NONE is live. **The design doc originally specified a
    node-level `active` set, and that is wrong**: it skips a JOIN (a node downstream of both the
    taken and the untaken path has one live parent and one dead one, and any rule phrased over
    parent *nodes* kills it). converger-v2.md §4 is corrected. A skipped node emits `step_skipped`,
    never `step_failed` — it is not a casualty.
  - **§11.2 falls out structurally**: with no `branch` in a spec, every edge goes live the instant
    its source completes, nothing is skipped, and the loop is the old one. The test asserts the
    exact event sequence is unchanged — that is what protects the workflows already in production,
    none of which use control flow.
  - **THE PERSISTED STEPS ARE NOT THE CHECKPOINT.** `workflow_runs.steps` holds the
    **display-shrunk event stream**: `_shrinkOutput` truncates at 2000 chars, appends a literal
    `…(truncated)`, and JSON-encodes objects, so the UI isn't flooded. The first design resumed
    from it — and a 3363-char drafted email came back as 2013 chars, so **the person approved one
    thing and the customer received a different, mutilated one**, ending in `…(truncated)`, with no
    error and a `run_completed`. ~400 words is nothing for a drafted reply, so every real approval
    would have resumed on corrupt state. The run now emits an explicit **`checkpoint`** on
    `run_paused` (`{outputs, skipped, live, ruledOut, lastOutput}` — the last two are load-bearing, see
    below — full fidelity), persisted to
    `workflow_runs.checkpoint`; it is written only on a pause, so it costs nothing on runs that
    never pause. **Rule: anything reading back a persisted step gets a DISPLAY COPY, not the live
    value.** (Found by the independent verifier. converger-v2 §7.4 asserted the opposite and is
    corrected.)
  - **`branch` and `human` are CONTROL nodes — their output never becomes `lastOutput`.** A
    branch's output is `{value, matched, to}`, a human's is `{decision, by, at, channel}`. `deliver`
    sends `ctx.lastOutput`, so leaving them in meant the step after an approval delivered the
    literal `{"decision":"approve",…}` to the customer instead of the approved reply. **This holds
    on BOTH executors** — the top-level loop (`flow-tester.js`, `CONTROL_TYPES`) *and* the `foreach`
    sub-loop, which has its own executor (`foreach.js`, `CONTROL_SUBSTEP_TYPES`). The sub-loop was
    missed at first: a validator-clean spec with a `branch` inside a `foreach` delivered
    `{"value":…,"viaCatchAll":true}` to the customer once per item (found by the independent
    verifier, round 8). A `branch` in a loop is now **rejected** (`BRANCH_IN_FOREACH`) — it is a
    structural no-op there anyway (a loop has no edges, so nothing routes) — and the engine drops
    control-node output from `last` regardless, since DB specs predate the rule.
  - `src/workflows/workflow-store.js` — `workflow_runs.status` CHECK widened to include
    **`awaiting_human`** (a run waiting on a person is not running, not a success, and not an
    error; leaving it `running` gets it swept as stale). SQLite can't alter a CHECK in place, so
    this is a probe-then-rebuild mirroring the existing `_migrateStatusCheckIfNeeded`. New columns
    `paused_node`, `pending_ask`; new methods `pauseRun` / `listAwaitingHuman` / `markRunResumed`.
    **A table rebuild must carry over EVERY column the old table had — not just the ones its DDL
    lists.** The first version copied `newCols ∩ oldCols`, which is a silent column-stripper: this
    table is *not* fully described by its `CREATE TABLE` plus `ADDITIVE_RUN_COLUMNS` — `read_at` is
    added by its own one-off `ALTER` further down `init()`, **after** the rebuild — so on any
    database where a previous boot had added it, the rebuild dropped it and re-added it empty. The
    independent verifier reproduced it on the real 653-row DB. The rebuild now `ALTER`s any unknown
    old column into the new table before copying, so the whole class is closed by construction
    rather than by anyone remembering to mirror the next column. Verified against a prod-shaped
    legacy DB: 653 rows and all 653 `read_at` values preserved, and `init()` twice is a no-op.
  - `src/workflows/idempotency-store.js` (new) — SHA-256 of the resolved key, scoped
    **`tenantId:workflowId:[foreachId/]nodeId`**. **A node declaring an idempotency key with no
    store wired — or with no tenant/workflow to scope it to — REFUSES to run.** Both are
    fail-closed, and the second one is why: the scope was originally
    `` `${workflowId ?? 'unscoped'}:${node.id}` ``, and **neither production caller passed
    `workflowId`**, so every tenant collapsed into one namespace (`unscoped:create_record`) in a
    store with no tenant column — tenant B's write was silently skipped and **tenant B's step was
    handed tenant A's output**, which then becomes `lastOutput` and is delivered. A cross-tenant
    leak, out of a `??` default. **A silent fallback is not a safety net; it is the bug.** Wired in
    `server.js` (`IDEMPOTENCY_DB`); the scheduler and the REST run path both pass
    `tenantId`/`workflowId`.
  - `src/workflows/workflow-validator.js` — `NON_EXHAUSTIVE_BRANCH` (every branch needs a `*`;
    without one an unanticipated value matches nothing and the workflow **silently does nothing**,
    which is the most expensive failure a router has and is invisible exactly when it matters),
    `BRANCH_CASE_NO_EDGE`, `BRANCH_TARGET_EXTRA_PARENT`, `ON_ERROR_ROUTE_NO_EDGE`,
    `ON_ERROR_BAD_TARGET`, `NESTED_FOREACH`, `HUMAN_IN_FOREACH`, `WRITE_WITHOUT_IDEMPOTENCY`
    (warning). Branch rules live in the validator, not in `branch.js`'s `validate(node)` hook,
    because they need the **edge list**.
  - **A ruled-out branch target is DEAD, not merely unlit.** Edge-liveness alone has a hole: if an
    untaken case target *also* has an edge from an earlier node, that edge is live whichever way
    the branch went — so the step runs anyway and **the branch decides nothing**. The engine marks
    non-selected case targets dead outright, and `BRANCH_TARGET_EXTRA_PARENT` rejects the ambiguous
    shape at build time. (Found by the independent verifier.) The engine does not rely on the
    validator having run — specs already in the database predate the rule.
  - **LIVENESS IS RESTORED FROM THE CHECKPOINT, NEVER RE-DERIVED.** The checkpoint carries
    `{outputs, skipped, live, ruledOut, lastOutput}`, and a replayed node **propagates nothing**.
    Re-running `propagate()` for already-done nodes is wrong, because it lights **all** of a node's
    outgoing edges while the original leg may have lit only **some**: a `branch` lights one case,
    and an `on_error: route_to` lights only the error target. Re-deriving therefore **revived the
    path the branch ruled out** *and* **revived the HAPPY path of a step that had failed** — the
    run went on to deliver as though the payment had not been declined. Liveness is a fact about
    what happened, not something to recompute from outputs. (Both found by the independent
    verifier; the second only surfaced when probing the first.)
  - **`branch` / `human` outputs are never `lastOutput`, and never a transform's input.** Two
    separate guards — `CONTROL_TYPES` in `flow-tester.js` (what `deliver` sends) and
    `NON_CONTENT_TYPES` in `node-types/_node-input.js` (what an `llm` step ingests). Miss either
    and the approval record `{"decision":"approve","by":"user:1",…}` reaches the customer, or the
    model.
  - **Never use an unprintable character as a separator.** The branch/edge lookup key was first
    built with a literal **NUL** (`${from}\0${to}`) — invisible in an editor and in a diff — and it
    silently failed to match the one site that used a space, so `ON_ERROR_ROUTE_NO_EDGE` fired on
    *every* `route_to` and the feature was unpublishable. This is the same class as the `server.js`
    NUL in Known gotchas below. `tests/workflows/control-flow.test.js` now fails if **any** file
    under `src/` contains a NUL byte.
  - **A GREEN SUITE PROVED NOTHING FOUR TIMES RUNNING. Mutation-test, don't trust the tick.** Every
    defect in this increment reached `main`-candidate state behind a passing suite, because each
    test passed *for the wrong reason*: the `route_to` test was **negative-only** (it would have
    passed if the check were `if (true)`, and indeed the check was rejecting every *correct* spec);
    the resume test's stub LLM returned **16 characters**, so it never crossed the 2000-char
    truncation cap; and it asserted a delivery *ran*, never *what it sent*. Two guards
    (`NON_CONTENT_TYPES`, the `doneSkipped` split) could be **deleted entirely with the suite still
    green**. So: **every validator rule needs a POSITIVE case** (the good shape is *accepted*), and
    **every guard must be mutation-tested** — re-introduce the bug and confirm a test actually
    fails. **Do not quote a mutation score in a doc** — two rounds here published one ("7/7",
    then "11/11") and an independent verifier falsified both by writing its own, wider list. A
    score is a claim about tests you did not write. State the RULE and let the next verifier
    re-derive the number.
    **Mutation-test the guards you add in the FIX, not just the ones you started with.** Both false
    scores came from exactly that: the round-4 fix introduced `checkpoint.ruledOut` and the
    "don't recompute `lastOutput` on replay" rule, never re-tested them, and **both survived
    deletion with the whole suite green** — dropping `ruledOut` let a ruled-out branch run and
    deliver on resume, verbatim the bug that commit was written to kill.
    **A test can be labelled `(pinned)` and not be pinned.** The `lastOutput` test said so in its
    own name while a `draft` node in its fixture laundered the value and masked the mutation
    entirely. Assert the DELIVERED BODY, put nothing between the step under test and the assertion,
    and *run the mutation*.
  - **`foreach` sub-steps must go through the same POLICY path as any other node.** They called the
    raw dispatcher, which silently skipped **`idempotency` and `on_error.retry` for every step
    inside a loop** — inverting the guarantee in the worst possible place. A write in a loop is N
    writes per fire (the highest-risk write shape the engine has, and the whole reason `foreach`
    exists), and it was the *only* shape where declaring an idempotency key did nothing: a sub-step
    with a key and **no store wired wrote twice and reported success**, while the identical
    top-level node refused to run.
  - **A `foreach`'s `steps` must NOT be template-substituted before the loop.** They were, with no
    item in scope, so `{{item}}` was replaced by an **empty string** before the first iteration —
    meaning `{{item}}` never bound at all, and an idempotency key of `{{item}}` resolved to `""`
    (falsy), skipping the dedupe check entirely. The test that "proved" `{{item}}` worked was
    passing for the wrong reason: the item reached the prompt only via `llm`'s auto-injection of
    `lastOutput`.
  - **`BRANCH_BAD_ON`** — the value a branch routes on is the one thing the node exists to read, and
    it was the one thing never checked. A one-letter typo (`clasify.output`) is not a template, so
    `BAD_TEMPLATE_REF` never fired; the engine took it as a literal, nothing matched, and the
    **mandatory catch-all then swallowed 100% of traffic — forever, silently, with
    `run_completed`**. The catch-all that exists to prevent a silent misroute was *masking* one.
    Rejected at build time.
  - **A `branch`'s `on` is a REFERENCE, not a template — it must stay RAW** (same carve-out as a
    `foreach`'s `steps`). The first fix for `BRANCH_BAD_ON` shipped two regressions, both of which
    crashed *valid* workflows, and both because `_runNode` substitutes config before the node sees
    it:
    - `on: "{{classify.output}}"` — the mainline shape — arrived as the classified **value**
      (`"urgent"`), which is indistinguishable from a step id, so the engine looked up a step called
      "urgent" and killed the run. **Data-dependent**, which is worse: `"urgent"` matched the id
      regex and crashed; `"needs review"` (a space) did not. Not one of the then-49 tests used the
      braced form.
    - The engine must distinguish **"no such step"** (a typo → fail loudly) from **"a real step that
      didn't run on this leg"** (an upstream branch skipped it → take the **catch-all**, which is
      exactly what a mandatory catch-all is *for*). Throwing on the latter failed a workflow the
      validator correctly accepts. `ctx.nodeIds` is what tells them apart.
  - **`scripts/gates/p12.sh` — one DESCRIPTION string changed** ("resumes from persisted steps" →
    "resumes from its checkpoint"). **No check was altered.** Recorded here because a diff against
    `scripts/` is exactly how a verifier detects a builder weakening their own gate — so it must
    never be silent. Left as-is, the gate itself would have taught the next agent the lie.
  - **`{{item}}` / `{{index}}` are bound ONLY inside a `foreach`.** Used anywhere else they are a
    `BAD_TEMPLATE_REF` at build time, rather than an empty string at run time.
  - **A `human` node is unreachable by design until increment D.** The engine pauses correctly, but
    nothing DELIVERS the ask yet (Slack buttons, signed magic links, the Approvals inbox are D).
    The converger doesn't emit one and the builder can't add one, so no user workflow can park
    itself waiting for a question nobody will ever be asked. **Do not surface `human` in the
    converger prompt or the builder until D lands.**

- **Converger v2 core — the outcome contract (2026-07-13, P12 increment C)** — the converger could
  agree to post to Slack **and** email the team, build only the Slack step, and nothing in the system
  could notice: no part of a spec ever declared what the finished workflow was supposed to
  **produce**. Spec v2 adds `outcome{statement, assertions[], examples[]}`, and a spec that does not
  deliver on its own contract **does not publish**.
  - **`src/workflows/outcome-oracle.js` (new)** — the SINGLE satisfaction oracle, imported by BOTH
    `workflow-validator.js` (`UNSATISFIED_ASSERTION`) and `converger/gap-scorer.js`. Two copies of
    this rule would drift, and the day they drift is the day the converger ratifies a spec that
    publish rejects — a dead end the user cannot argue their way out of. Assertion kinds are a
    **closed set** (`message_sent · record_exists · document_exists`); an assertion outside it is
    `MALFORMED_ASSERTION`, **never a silent pass** — an uncheckable promise reported as met is the
    same failure as a missing delivery, just better hidden.
  - **`src/converger/gap-scorer.js` (rewritten)** — `scoreGap(spec, {capabilities}) → {gaps, complete}`,
    three classes (outcome/coverage/contract). The old five-item checklist demanded a *processing*
    node, which is why the converger invented a pointless LLM step for a genuinely two-step workflow
    and charged for it on every run (defect #4). **The contract/outcome gaps ARE the validator's
    issues, classified — not a second opinion.**
  - **A BLOCKING gap can NEVER default to `'escalated'`.** converger-v2 §3 specified a blanket
    `'escalated'` default; that is **unimplementable** — it makes `complete` unconditionally true, so
    an EMPTY draft scores complete and the converger ratifies a workflow with no steps. Escalation
    promises a person handles the case **at run time**, and a spec that cannot publish has no run
    time. Blocking ⇒ `'unanswered'`, which buys **`complete ⇒ publishable`** by construction. **A
    default that makes a check vacuous is not a safety net; it is the bug** — same class as the
    `?? 'unscoped'` tenant fallback that leaked across tenants in B. §3 is corrected.
  - **`LLM_INPUT_NOT_ENUM` (§11.7, THE MOAT) covers TWO shapes.** Scoped to `decision` inputs alone
    it would guard **nothing that can run** — `decision` is not a registered node type until E, so
    the check would be pure theatre. The shape that *can* run today has the identical defect: a
    **`branch` routing on an `llm` node not in `classify` mode**. A branch matches by exact value, so
    free prose matches nothing and **the mandatory catch-all silently swallows 100% of traffic**,
    with `run_completed` and no error — verbatim the `BRANCH_BAD_ON` failure through a different
    door. This forced the one edit to a prior increment's test (`control-flow.test.js`'s
    skipped-step fixture routed on a *freeform* llm; the mode was incidental to the invariant it
    pins). The fixture was changed, the assertion left untouched, and **the test was re-mutation-
    tested to confirm it still goes red when B's original defect is restored.**
  - **`deliver` keys are deliver's ∪ the CHANNEL's — a LIVE defect from increment A, fixed here.**
    A delivery channel is a capability with its own params: `sheets_append`'s handler reads
    `config.spreadsheetId`/`config.range` (`src/connectors/google/index.js:694`),
    `airtable_create_record` reads `baseId`/`tableId`/`fields`. None is a `deliver` key, so **every
    delivery to a Sheet or an Airtable base was rejected at publish** — while the converger's system
    prompt rendered exactly that shape from the channel catalog and told the model to emit it. The
    builder was instructing users to build workflows it would then refuse to save. (Slack/Gmail
    escaped only because their keys overlap deliver's own.) This **narrows a lie in the schema; it
    does not widen the check** — `model` and `message` are still rejected. It is why `scoreGap` takes
    `capabilities`: the gap scorer must judge against the same channel catalog the server has, or
    `complete ⇒ publishable` is aspirational rather than true.
  - **The outcome is a FLOOR, not a ceiling.** It proves nothing was silently **dropped**; it cannot
    prove every transformation is **present** — *"a summary of the email"* and *"the email"* reach
    Slack as the same assertion, and inventing an assertion that claimed to tell them apart would be
    a proof we cannot make. So once the floor is met the INTENT gets the last word: `analyze` asks
    the model once if the draft is finished and it must **name** a concrete missing component to
    continue (bounded). Unlike v1's checklist, "finished" is the default answer — so a 2-node
    workflow still ratifies untouched.
  - **`assertion.when` is carried but NOT proven** — proving it needs `decision` (E) + the examples
    as a test suite (G). A conditional assertion therefore raises a non-blocking
    `CONDITIONAL_UNPROVEN` gap rather than being counted satisfied by an ungated node, which would
    let the workflow pass its own contract while pinging `#sales-urgent` for **every** lead.
  - **No `decisions` graph node, and no `human` in the prompt.** converger-v2 §3 listed a `decisions`
    node that "builds tables"; it cannot — the `decision` node type does not exist until E, so it
    could only emit an unrunnable spec. Same trap as surfacing `human` before D builds the surface
    that asks it. A decision today is `llm`+`classify` → `branch`.
  - `mutation-sweep.mjs` `TARGETS` widened to `workflow-validator.js` + the three C files (the round-9
    residual). It immediately found that **most of the pre-existing validator publish gate**
    (`MISSING_TRIGGER`, `CYCLE_DETECTED`, `DELIVER_NO_INPUT`, `SELF_LOOP`, `UNKNOWN_CHANNEL`, …) was
    pinned by **no test at all**. The floor is a ratchet: it was **not** lowered to accommodate the
    new files.
  - Also: `interaction-store.js` handled exactly three event types and **silently dropped every
    other** — so the moment the graph gained an interrupt, its entire record would have vanished with
    no error. It now stores unrecognised events, plus a `converger_provenance` table (which turn
    produced each assertion; which gaps escalated by default) that feeds the SOP.

- **The five defects the `test-adversary` found in C — all behind a fully green suite (2026-07-13).**
  Same lesson as B, and it landed on the first run of the agent built to prevent exactly this.
  Pinned by **`tests/converger/moat-adversarial.test.js`**, which is now in the gate and in the
  mutation sweep.
  1. **THE MOAT WAS BYPASSED BY ONE LAUNDERING HOP.** `LLM_INPUT_NOT_ENUM` asked *"is the branch's
     source an `llm` node that isn't classifying?"* — **a denylist**. Put an `assemble` between a
     freeform `llm` and the `branch` (`content: "{{think.output}}"` — a shape the converger is
     explicitly taught to emit) and the check never fires: `validator.ok === true`. The branch then
     routes on free prose, nothing matches, and **the mandatory catch-all swallows 100% of traffic,
     silently, with `run_completed`** — verbatim the failure `BRANCH_BAD_ON` exists to prevent. Same
     hole through `search_web` and `connector-action`. **§11.7's property is "the routed-on value has
     a CLOSED, DECLARED domain", not "its parent isn't an LLM" — laundering a value through another
     node does not bound its domain, it only hides who produced it.** It is now an **allowlist**: a
     branch may route only on `llm`+`classify` (categories), `decision` (output values), or `human`
     (approve/reject/timeout). A new source type earns its place by **declaring its value set**.
     **A denylist on a security-relevant property is the same class of bug as a `??` default: it is
     wrong by construction, and it fails silently.**
  2. **A malformed decision rule silently covered the WHOLE table.** `rule?.when?.[key]` on a `null`
     rule yields `undefined`, which the analyser reads as `-` (irrelevant) — i.e. "covers every
     value on every dimension". One bad rule (exactly what an LLM emits) made `analyzeTable` report
     `uncovered: []` **and** `hasCatchAll: false` simultaneously, which cannot both be true: a clean
     bill of health for a table it could not read. That is the **false proof** the module's own
     header forbids. A rule with no readable `when` is now `decidable: false`.
  3. **Duplicate assertion ids dropped an assertion.** `checkOutcome` keyed `satisfied` by
     `a.id ?? a.target`, so two assertions sharing an id collapsed to one Map entry — falsifying the
     single property the oracle exists to guarantee. Worse, the survivor carried the *first*
     assertion's `fields`, so a second assertion's `fields:['Budget']` was checked against a list
     that never mentioned Budget and **a spec that never wrote Budget published clean**. Keyed by
     **index** now (unique by construction), plus `DUPLICATE_ASSERTION_ID`. **A key that CAN collide
     is a silent drop waiting to happen.**
  4. **`integer` inputs got a PHANTOM gap.** The domain was partitioned over the reals, so `<=0` +
     `>=1` — exhaustive over the integers — reported an uncovered cell *"between 0 and 1"*. That is
     the module's *other* named failure mode ("invent a gap that isn't there"), and it is the more
     corrosive one: **a question with no real answer is what teaches people to click past the
     questions.**
  5. **A `null` node made `validate()` THROW**, and `WorkflowService.create()` calls it with no
     try/catch — so publish returned a **500** instead of the clean `MALFORMED_NODE` the validator
     had already generated one line earlier. Pre-existing on `main`. Malformed nodes are now removed
     from the working set before any check runs. **Turning bad input into a message is the
     validator's entire job; crashing on bad input is the one thing it must never do.**
  - **`scripts/gates/p12.sh` and `mutation-sweep.mjs` SUITES both gained `moat-adversarial.test.js`.
    Checks ADDED, never weakened** — recorded because a diff against `scripts/` is how a verifier
    detects a builder quietly weakening their own gate, so it must never be silent.

- **The independent verifier then FAILED increment C, and was right (2026-07-13, round 2).** The
  headline invariant was false and **the check written to prove it could not fail**. Third time this
  phase; the lesson keeps arriving in a new costume.
  - **`complete ⇒ publishable` was FALSE with no channel catalog.** The validator's channel checks
    sit behind `if (channelId && this.channelRegistry)` — so with no registry `UNKNOWN_CHANNEL` and
    `CHANNEL_UNAVAILABLE` **silently do not run**, while publish (which always has one,
    `server.js:542`) still enforces them. A `deliver` to a hallucinated `channel:'discord'` scored
    **complete** and then failed to publish: the builder says done, the save button says no.
    It **disabled itself exactly when it mattered** — `builder.js` built the catalog after three
    network-bound connector lookups inside a *"non-fatal"* catch, so an expired refresh token dropped
    it, and in that same state the model has no catalog in its prompt either and is at its **most**
    likely to invent a channel id. **A check that silently degrades is not a safety net; it is the
    bug** (the `?? 'unscoped'` lesson, third occurrence). `scoreGap` now **refuses to certify**
    without a catalog (`CHANNELS_UNVERIFIED`, blocking) and `builder.js` guarantees one.
    **Refusing to certify is always available; certifying without checking is not.**
  - **The check that was supposed to catch it was structurally incapable of failing.**
    `converger-adversarial.mjs` check 6 (*"complete ⇒ publishable"*) **scored with no capabilities
    and validated with no `channelRegistry`** — both sides equally blind, so the divergence was
    invisible **by construction**. Production validates *with* a registry. That is **architectural
    flaw #2, verbatim**: *a check that exercises a configuration production never uses cannot see the
    bug production has.* The generated sweep had even listed the exact line (`gap-scorer.js`
    `byId.get(id) ?? null`) as a **survivor**, and the builder read past it.
    **Rule: a check must construct its subject the way PRODUCTION constructs it. If your test hands
    in something production omits — or omits something production hands in — it is testing a program
    nobody runs.** `p3-converger-run.mjs` was fixed the same way: it drove the converger with no
    channel catalog at all.
  - **`BRANCH_CASE_NOT_IN_ENUM` (new).** A branch on a `classify` whose cases name values the
    classifier **cannot produce** (`"HIGH"` when the categories are `urgent|normal`) validated clean
    and scored complete. Every run takes the catch-all — silently, forever, with `run_completed` —
    while the converger reports the workflow finished. **We forced the domain closed precisely so
    membership would be DECIDABLE, and then never decided it.** Closing a domain and not checking
    against it is a completeness claim nobody made good on. `closedDomainOf()` is now the single
    definition of "what values can this node emit", shared by the allowlist and the case check, so
    the two cannot drift.
  - Also: `ratify` shipped a finished-looking draft with unresolved **blocking** gaps (the user found
    out on a failed save) — it now carries `publishable` + `blockers`; and the outcome-candidate
    filter silently dropped a requested connector (**defect #1 relocated from the spec into the
    candidate list**) — it now says what it refused to promise, and why.

- **The human approval gate (2026-07-13, P12 increment D)** — Increment B built the durable pause
  and stopped there **on purpose**: an approval anyone can forge is not an approval, so the
  authentication got its own increment and its own adversarial check. D is that half. A `human`
  node is now reachable: the ask goes out, the answer comes back **proven**, and an unanswered one
  never becomes a yes.
  - **`src/approvals/approval-store.js`** (new) — mirrors `password-reset-store.js`: 32 random bytes,
    **SHA-256 hash only** on disk, single-use, TTL from the node's own `timeout.after`. **One token
    per `(runId, nodeId, decision)`** — approve and reject are *different secrets*, so a forwarded
    "approve" link cannot be edited into a "reject"; and **consuming either burns both**, because a
    question that has been answered must not be answerable again by the next person down the thread.
    `issue()` **throws** without a tenant (a `?? 'default'` here would be a cross-tenant forgery
    primitive — the `?? 'unscoped'` lesson, fourth occurrence).
  - **`src/approvals/approval-service.js`** (new) — the ask, over every declared channel in parallel
    (first valid answer wins), and one `resolve*()` per channel. **Each proves who is answering
    BEFORE the engine sees it**: `inbox` an authenticated session whose tenant must match the run's;
    `slack` an HMAC-verified `block_actions` carrying the Slack user id; `email` a signed, hashed,
    single-use magic link. There is exactly ONE door into the engine (`scheduler.resumeRun`) and it
    authenticates nothing, by design. **A fifth channel proves its answerer before it reaches that
    door, or it is not a channel.**
  - **`GET /approvals/:token` DECIDES NOTHING.** It is a link in an email, and things that are not
    people fetch those: scanning proxies, link checkers, the mail client's own prefetcher. If the GET
    consumed the token, a corporate security appliance would approve the customer's refund
    milliseconds after the mail landed. The GET renders a page; a **POST** from it answers.
  - **`POST /connectors/slack/interactive` is a DIFFERENT URL from `/connectors/slack/events`**, and
    it needs its own body parser: Block Kit buttons arrive `application/x-www-form-urlencoded` with
    the payload in a `payload` field, and the global `express.json` leaves `req.body` empty — which
    would make the signature unverifiable. The tenant is resolved from the Slack **team id**, never
    from the button's `value`: a value is a routing hint, and a routing hint that could name a tenant
    is a cross-tenant forgery primitive.
  - Validator (§7.7): **`HUMAN_WITHOUT_TIMEOUT`** (a pause with no deadline never ends, never fails,
    and never tells anyone), **`HUMAN_BAD_TIMEOUT`** (a `then` outside the node's own answers takes a
    path nobody wrote — the `BRANCH_BAD_ON` class), **`WEAK_APPROVAL_FOR_WRITE`** (an emailed link
    proves possession of a mailbox and is forwardable; it may not stand alone in front of a send or a
    write), **`APPROVAL_CHANNEL_NOT_CONNECTED`**, **`EMAIL_REPLY_APPROVAL`** (§11.8 — `From:` is
    forgeable, SPF/DKIM authenticate a sending *domain* rather than a human *intent*, and a forwarded
    thread is full of the word "yes"). `src/workflows/approval-channels.js` is the **single** trust
    table, read by the validator, the gap scorer and the service, so they cannot drift.
  - **`complete ⇒ publishable` held only because the scorer FAILS CLOSED — and D moved the hole one
    door along.** `APPROVAL_CHANNEL_NOT_CONNECTED` needs an approval-channel view; without one the
    check silently does not run, so a pause asking over a Slack workspace nobody connected would
    score `complete` and then refuse to publish. That is the C blocker exactly. `scoreGap` now
    refuses to certify a spec containing a `human` node when it cannot see the channels, and
    `builder.js` builds the view from the LOCAL registry (so a network failure cannot knock it out).

  **Four live defects found while building it — three of them pre-existing:**
  1. **A FAILURE PATH WAS ALSO A SUCCESSOR.** `on_error: { then: 'route_to:handler' }` requires an
     edge `node → handler` (the validator *enforces* it), and `propagate()` lit **every** outgoing
     edge on success — including that one. **So the only shape the validator accepted was the shape
     that misfires:** the error handler ran on every healthy run, silently, with `run_completed`. A
     "this broke" Slack post every morning — and, the moment D landed, an approval gate meant only
     for failures pausing **every single run**. Pre-existing in B, behind its green suite.
  2. **The documented approval shape could not be built.** §7.1 has always said a branch routes on
     `{{approve_send.decision}}`. The engine's reference grammar accepted only `<id>` / `<id>.output`,
     so that spelling was rejected at publish — i.e. *every* approval gate an LLM writes would have
     bounced, on the increment's headline feature. `ON_REF` now accepts `.output | .decision`, and
     **only** those: a branch may read a field whose domain `closedDomainOf()` declares, and nothing
     else. Routing on `classify.confidence` would leave the case check validating a value nobody is
     routing on — the moat, through a new door.
  3. **`timeout` was not an answer the engine would accept.** `closedDomainOf()` has always declared
     it part of a human node's closed domain (so a branch may carry a `timeout` case), but
     `human.run()` threw on it — because before the sweeper existed nothing could produce one. The
     declared timeout path was unreachable. **An unanswered approval still never becomes an
     `approve`**: the sweeper resolves `timeout.then` only when it names one of the node's own
     answers, else `timeout`. Silence is not consent.
  4. **The Approve button sent no answer** — and only rendering the UI in a browser found it.
     `_H()` already sets `Content-Type`; the handler spread it **and** added a lowercase
     `'content-type'`, and the `Headers` constructor **appends** duplicate names rather than
     replacing them. The request went out as `content-type: application/json, application/json`,
     which `express.json()` does not recognise, so the body was never parsed and the click came back
     *"no answer given"* with the run still waiting. **Render the UI. The scripts passing and the
     server booting is not the same as a person being able to click the button.** (This was C's
     recorded residual, and it was worth exactly what it cost.)

  **`escalation.js` (new) — escalation finally MATERIALISES.** C made "escalate" the default
  resolution of every non-blocking gap, which is what makes *"Accept all defaults"* honest — and then
  emitted a spec in which nothing asked anybody anything. The promise was real at build time and
  empty at run time, which is the worst place for a promise to be empty: **the user has stopped
  worrying about it.** Now `NO_ERROR_PATH` → `on_error: {retry:2, then:'escalate'}` (a failure reaches
  the owner's Approvals list instead of a log nobody reads), and `CONDITIONAL_UNPROVEN` → a real
  `human` gate in front of the step, because the honest escalation of *"I cannot decide this"* is to
  **ask**. Anything else escalated is **reported as unmaterialised, by name, with the reason** — a
  gap we said we would escalate and then quietly did nothing about is a lie in the language of safety.

  **A `human` node ALONE IS NOT A GATE — it needs a `branch`.** Nothing stops the step after a
  `human` from running; `human` only *reports* the answer, exactly as `branch` only reports a route.
  So `draft → approve_send → send_email` — which is what converger-v2 §7.1's shape read like —
  **sends the email whether the person approved or rejected it.** It looks precisely like an approval
  gate and is precisely a no-op. §7.1 is corrected; `escalation.js` materialises the routed shape and
  `prompts.js` teaches it.

  **`scripts/` diffs — checks ADDED, never weakened** (a diff against `scripts/` is how a verifier
  detects a builder quietly weakening their own gate, so it must never be silent):
  - `scripts/gates/p12.sh` — **not modified.** D's block was written in advance and is the checklist.
  - `mutation-sweep.mjs` — `TARGETS` **widened** to `approval-store.js`, `approval-service.js` and
    **`workflow-scheduler.js`** (closing the round-9 residual, which asked exactly this once an
    increment touched the scheduler). `SUITES` gains the two approvals suites + a new
    `tests/workflows/scheduler.test.js`. **The floor was NOT lowered.**
  - **The widened sweep immediately earned its keep:** the scheduler — the choke point every real run
    passes through, and where the monthly-run **plan cap** is enforced — had **no unit tests at all**.
    `if (allowed === false)` (the cap itself) could be inverted with the whole suite green. It has a
    suite now.
  - **The Slack/email surface was covered ONLY by `approval-adversarial.mjs`, which the sweep does not
    run** (it runs `node:test` suites), so the sweep reported all of it as unkillable — correctly. **A
    mutant is only killable by a suite that EXECUTES it, and "some other script covers it" is exactly
    how a guard ends up pinned by nothing.** Hence `tests/approvals/approval-channels.test.js`.
  - `tests/workflows/control-flow.test.js` — **one FIXTURE changed, no assertion touched.** Its
    "positive: a well-formed human step validates" case had a `human` node with **no channels and no
    timeout**, which D makes an error. B could not have known: it had no way to deliver an ask, so
    "well formed" then meant only "has a prompt and two answers". The old fixture was not a
    well-formed human step; it was an *unanswerable* one that nothing had yet noticed. The invariant
    the test pins — **the good shape is ACCEPTED** — is untouched and still holds.

- **The verifier FAILED increment D, and the test-adversary corroborated it — 4 blockers, all behind a
  green suite (2026-07-13, round 2).** Same lesson as B and C, a fourth time: the headline invariant of
  the increment (*"a `human` node alone is not a gate; the step after it does not run on reject"*) was
  **false**, and it took an independent pair of eyes to see it. All four are now fixed and pinned by
  `tests/approvals/gate-adversarial.test.js` (in the gate + the sweep). **Three of the four were a
  LAUNDERING HOP one step to the left of a real check** — the exact shape CLAUDE.md names three times.
  1. **A `human` node ALONE IS NOT A GATE.** `draft → ask → send` (no branch reading the decision)
     validated clean, and on **reject the customer got the draft anyway**. `human` only REPORTS its
     answer (like `branch` reports a route); nothing stopped the next step. `escalation.js` and
     `prompts.js` both *asserted* "the validator will reject it if any is missing" — it did not. Fixed on
     **both sides** (the doctrine `BRANCH_TARGET_EXTRA_PARENT` follows): the validator rejects it
     (`HUMAN_ANSWER_NOT_ROUTED` — a human's successor must be a `branch` that routes on
     `{{<id>.decision}}`), and the **engine** lights only that gating branch, so a DB spec that predates
     the rule cannot deliver a rejected draft either (`flow-tester.js` propagate(), `isGateFor`).
  2. **`.decision` defeated the moat.** Increment D taught `BRANCH_BAD_ON` the `.decision` reference
     form and left **two other parsers** (`_checkDecisionInputs`, `BRANCH_CASE_NOT_IN_ENUM`) on the old
     `/\.output?$/` regex — so on the ONE shape §7.1 documents and `escalation.js` emits
     (`on: "{{ask.decision}}"`), the moat and the case-membership check silently `continue`d. A case
     `"approved"` (typo of `"approve"`) published clean, matched nothing, and the mandatory catch-all
     swallowed 100% of traffic. **All three parsers now use the shared `ON_REF`** — three parsers of one
     reference is three chances to disagree; there is one now.
  3. **Silence became consent.** `timeout: { then: 'approve' }` passed `HUMAN_BAD_TIMEOUT` (approve IS a
     declared answer) and the sweeper handed the engine `approve` with `by: 'system:timeout'` — nobody
     read the draft, the customer got it. `sweepTimeouts`'s own docblock swore *"It never resolves as
     `approve`."* Fixed **behaviorally, not by banning the word "approve"**: `timeoutAuthorizesWrite()`
     traces what the timeout decision would ACTUALLY do (follow the branch case to its subtree, ask if it
     writes), so it is exact for any decision vocabulary (`ship`/`hold`, not just `approve`/`reject`).
     The validator rejects it; the sweeper **downgrades to `timeout`** for DB specs that predate the rule.
     **A timeout may say DON'T (`reject`) or escalate — it may never perform the action the approval
     existed to gate.**
  4. **`WEAK_APPROVAL_FOR_WRITE` was laundered by a `foreach`.** `isWriteNode` checked `deliver` /
     writing `connector-action` but never looked inside `foreach.config.steps`, so an **email-only**
     (forwardable) approval in front of a loop of `airtable_create_record` was accepted while the
     identical single write was refused. A loop is N writes per fire — the highest-risk write shape the
     engine has, and the one place the rule was blind. `isWriteNode` now recurses into `foreach` steps.
  - **9 existing control-flow tests regressed on the B1 engine fix, and that was EXPECTED** (the
    adversary flagged it before I merged): those resume/fidelity fixtures used the now-invalid ungated
    `human → deliver` shape. **Fixtures updated to route through a branch; not one assertion touched** —
    the checkpoint-fidelity invariant (the SENT body equals the APPROVED draft) still holds, because a
    `branch` is a CONTROL node and does not launder `lastOutput`. A diff against `control-flow.test.js`
    shows only fixture graphs changing, which is how a verifier confirms the assertions were preserved.
  - **Residuals fixed in the same pass (the verifier classified them non-blocking; they were cheap and
    R1 was genuinely broken):** **R1** — the approval Slack post read `getSlackGrant(...)?.botToken`,
    which is **always undefined** (that function returns `{connected, scopes, account}`, no token), so a
    tenant's approval posted into the OPERATOR's Slack; now uses `getSlackToken({...cipher})` like
    `server.js:353`. **R2** — the raw magic-link token was written to the event-log path in plaintext,
    undoing the store's hash-only model; the logger now redacts `/approvals/<token>`. **R3** —
    `timeout.then: 'escalate'` routed to the catch-all but notified nobody (inert); the sweeper now
    calls the escalation notifier, so `escalate` is meaningfully different from a silent `timeout`.
  - **A FIFTH defect, on the verifier's re-check of the fix — silence-as-consent THROUGH THE
    CATCH-ALL, and it MOVES MONEY.** F3 fixed `then: 'approve'`, but the value the sweeper injects
    *most often* is the `timeout` floor (whenever `then` is unset), which routes through the branch's
    **mandatory catch-all**. An INVERTED gate — `cases:[{when:'reject',to:'drop'},{when:'*',to:'send'}]`
    with no `then` — validated clean, and on a silent timeout **SENT the refund with nobody having
    approved it**. Both guards structurally exempted `TIMEOUT_DECISION`, so the one decision the sweeper
    injects most was never traced. The verifier classified it a *residual* (the converger only emits the
    safe shape — `escalation.js` puts the non-write on the catch-all — so it is not generated-reachable)
    but recommended closing it because it moves money. **Closed, not merely recorded** — a money-moving
    violation of this increment's own "silence is not consent" invariant is not something to leave open
    behind a note. Fixed on both sides: the validator rejects a `human`-gate whose silence-injected
    decision routes to a write (`HUMAN_BAD_TIMEOUT`, the catch-all trace), and the **sweeper refuses to
    resume — it fails the run** when even `timeout` writes (no safe path exists). Pinned by
    `gate-adversarial.test.js` F5; both guards mutation-killed.
  - **The apparatus worked.** Every one of these reached a green-suite, browser-verified state and was
    caught only by the independent verifier + adversary running in parallel. `mutation-sweep` TARGETS
    now covers the validator, the scheduler, and the approvals; `gate-adversarial.test.js` is in both the
    gate and the sweep. **A green suite is evidence of nothing until a second pair of eyes has watched
    it go red.**

  **⚠️ OPERATIONAL HAZARD, learned the hard way (TWICE): mutation-testing eats uncommitted work.**
  - `mutation-sweep.mjs` **rewrites files under `src/` in place** and restores them between mutants.
    Run in the background while you are editing, it will clobber your work — or, if it is killed
    mid-mutant, leave a **live mutant in your source tree** (`if (!fetcher)` → `if (false)`; a `throw`
    → `void 0 && …`). Run it in the FOREGROUND, and if it is ever interrupted,
    `grep -rn "if (true)\|if (false)\|void 0 && " src/` before doing anything else.
  - **A hand-rolled mutation loop that restores with `git checkout -- <file>` reverts to HEAD, NOT to
    your working tree.** If you have UNCOMMITTED edits in that file, `git checkout` **silently deletes
    them** — there is no stash, no reflog, no recovery except replaying the edits. This wiped an entire
    round of validator + engine fixes mid-session (recovered only because every edit was still in the
    agent's context). **COMMIT before you mutation-test, or restore with a saved copy
    (`cp f /tmp/f.bak` … `cp /tmp/f.bak f`), never `git checkout`.** The grep for mutant signatures is
    also your tell that a restore reverted too far: run it, and run the full suite, immediately after
    any mutation loop.

- **The `decision` node — the completeness proof, turned on (2026-07-14, P12 increment E)** — C built
  the DMN engine (`decision-analysis.js`: box subtraction, 10¹⁰ combinations in ~1 ms) and could not
  reach it from anything runnable: `decision` was not a registered node type, so **the moat guarded a
  shape no spec could contain**, and the analysis ran only in the converger — never at publish. E makes
  it real.
  - **`src/workflows/node-types/decision.js` (new)** — `inputs · output · hitPolicy · rules`, all under
    **`config`**. converger-v2 §2.2 drew them on the NODE, and **the engine cannot run that shape**:
    `run(cfg, ctx, services)` is handed `node.config` and nothing else, so a table hung off the node is
    a table the executor never sees — and one sitting outside `MISSING_CONFIG` / `UNKNOWN_CONFIG_KEY`,
    i.e. outside every check that makes a spec's shape true. `tableOf()` still **reads** the top-level
    spelling (so the moat and the analysis bite on it) and the validator **rejects** it. §2.2 corrected.
  - **AN UNCOVERED CASE THROWS.** It never returns null and never guesses. A null would reach the
    downstream `branch`, match no case, and be swallowed by the **mandatory catch-all** — a silent
    no-op with `run_completed`, which is verbatim the failure this phase exists to make impossible.
    That is why `DECISION_TABLE_GAP` can honestly be a **warning**: the escalation is real
    (`escalation.js` puts `on_error: {retry:1, then:'escalate'}` on the decision, so the throw reaches
    a person), and `complete ⇒ publishable` still holds because the gap scorer classifies by severity.
  - **ONE FEEL-A GRAMMAR.** `matchesCondition()` lives in `decision-analysis.js` beside the analysis
    and is built from the same `parseNumeric` / literal / `not()` code. A private copy inside the node's
    `run()` would be a second implementation of the rule language, and **the day they disagree the
    coverage proof describes a program nobody is running** — the analyser certifies every case is
    covered while the engine, reading the same table by different rules, matches nothing. Same doctrine
    as `outcome-oracle.js`. For the same reason the **DMN analysis moved into the validator**
    (`_checkDecisionTables`) and `gap-scorer.js`'s hand-rolled copy was **deleted**: publish and
    converge now consult one oracle, so the converger cannot ratify a table publish rejects.
  - **An unparseable condition is not "no match".** The engine **refuses to run** a rule it cannot
    read, rather than treating it as unmatched — which would silently narrow the table at run time
    while the analyser (which reports it as a bad condition) believed it was covered.
  - **`decision` is a CONTROL node** — added to `CONTROL_TYPES` (flow-tester) and `NON_CONTENT_TYPES`
    (`_node-input.js`), exactly as `branch`/`human` are. Its output is `{value, text, rule, inputs}` —
    the answer plus **which row fired** (the audit trail). Left out, a `deliver` after a decision sends
    the customer `{"value":"P1","rule":{…}}` instead of the draft. `text` is what a template renders,
    so `{{score.output}}` → `"P1"` rather than a JSON blob.
  - **A `branch` may NOT route on a `COLLECT` table** — it emits a *list*, and a branch matches by
    exact value, so nothing matches and the catch-all swallows 100% of traffic. `closedDomainOf()`
    returns `null` for one. Same class as `BRANCH_BAD_ON`, reached through the hit policy.
  - New validator codes: `DECISION_TABLE_GAP`, `UNIQUE_HIT_OVERLAP`, `DECISION_UNDECIDABLE`,
    `DECISION_BAD_CONDITION`, **`DECISION_OUTPUT_NOT_IN_ENUM`** (a rule's `then` outside `output.values`
    is a value nothing downstream has a case for — the `BRANCH_CASE_NOT_IN_ENUM` failure through the
    other door), **`DECISION_UNKNOWN_INPUT`** (a `when` on an undeclared key is **silently ignored** by
    the analysis, so the rule covers boxes its author believed it excluded — the proof would be about a
    different table), `DECISION_TOO_WIDE` (>4 inputs — **cognitive**, not computational: an unreviewable
    table is not auditable, which is the moat), `DECISION_BAD_HIT_POLICY` (an unrecognised policy is
    rejected, **never quietly read as FIRST** — that would run the table under a policy its author did
    not choose, and UNIQUE's promise would never be checked), `DUPLICATE_DECISION_INPUT`,
    `DECISION_BAD_INPUT_REF`.
  - **UI (`decision_review`)** — a TABLE, not prose: collapsed to one sentence by default, expanding to
    a grid whose cells are **dropdowns over the declared enum values** (a number gets a text box — its
    conditions are ranges, which no dropdown can enumerate), plus the hit policy as a plain-language
    radio (never the DMN letter). The dropdowns are only renderable *because* `LLM_INPUT_NOT_ENUM`
    forced the domain closed: the completeness proof is what makes the multiple-choice UI possible, and
    the multiple-choice UI is what makes the proof affordable to the user. Same asset (§13). The
    `decisions` graph node runs **before** `gaps`, so the gap list is about the table **as corrected**.
  - `mutation-sweep.mjs` — TARGETS **widened** to `node-types/decision.js` (the EXECUTOR that must
    agree with `decision-analysis.js`, which has been swept since C), SUITES gains the three decision
    suites. **Floor held at 0.78 — a ratchet, never lowered.** `scripts/gates/p12.sh` — E's block
    gained the three suites: the three checks it shipped with are a `grep` and an `ls`, which prove
    the SYMBOLS exist and not that anything enforces them (architectural flaw #1, verbatim).
    **Checks ADDED, never weakened.**

  **The verifier and the test-adversary found SIX live defects in E, three of them SILENT — and every
  one was behind a green suite (2026-07-14, round 2).** Fifth increment running. Pinned by
  `tests/workflows/decision-adversarial.test.js` (the six) and `decision-pinning.test.js` (the sweep's
  behavioural survivors); both are in the gate and the sweep.
  1. **A `decision` INSIDE A `foreach` DELIVERED THE DECIDED VALUE TO THE CUSTOMER, once per row.**
     `foreach.js`'s `CONTROL_SUBSTEP_TYPES` is a **second executor**, and `decision` was added to
     `flow-tester.js`'s `CONTROL_TYPES` and `_node-input.js`'s `NON_CONTENT_TYPES` and **not to it** —
     so the decision's `{value,text,rule}` became the iteration's `last` and `stringifyOutput` picked
     its `.text`: the channel received a plausible-looking `"P1"` instead of the lead, with
     `run_completed` and no error. **This is the THIRD time this exact line has been the defect** —
     CLAUDE.md's own increment-B block says "the sub-loop was missed at first" about `branch`, and it
     was missed again. **A new control type is not done until it is in BOTH sets.** Fixed on both
     sides (`CONTROL_SUBSTEP_TYPES` + a new `DECISION_IN_FOREACH`, mirroring `BRANCH_IN_FOREACH` — a
     decision in a loop is a structural no-op there anyway, because nothing inside a loop can route on
     its answer).
  2. **THE MOAT HAD A SECOND DOOR, and it was the one the deciding happens through.**
     `LLM_INPUT_NOT_ENUM` fires only on `evaluator:'llm'`. Declare an input `type:'enum'` with **no
     evaluator** and point its `from` at a *freeform* `llm`, and prose walked straight into the table:
     `coerce()` `String()`d it and handed it over, where it matched no rule but the catch-all. The
     workflow decided `P3` on an input reading *"This is EXTREMELY urgent — the server is on fire"*,
     and `analyzeTable` certified `decidable: true, uncovered: []` over it. **A false proof, with a
     receipt in the audit trail.** §11.7's property is *"the value being decided on has a CLOSED,
     DECLARED domain"* — **not "an LLM didn't type it"**. A value's domain is not bounded by who
     produced it, so the check belongs where the value **enters the table**, on every path in.
     `coerce()` now rejects an off-enum value (it throws → escalates → reaches a person, which is
     exactly what an unanticipated case must do). Same class as C's laundering hop: **a check scoped to
     the PRODUCER instead of the VALUE is wrong by construction.**
  3. **THE CLASSIFIER RETURNED THE VALUE THE MODEL NEGATED.** The off-enum fallback was *"the first
     declared value appearing ANYWHERE in the answer"* — so with `['approve','reject']`, the answer
     *"I would reject this — do not approve"* classified as **`approve`**, and the table decided on it
     with full confidence. It never returned free text; it returned **the wrong member of the set**,
     which is worse, because every downstream check passes. It also made any value that is a PREFIX of
     another (`ship` vs `ship_hold`) unreachable the moment the model added a preamble. Now: exact
     answer wins, else the answer must contain **exactly one** declared value on **word boundaries**;
     an ambiguous answer to a closed question is not an answer, so it throws. **The identical fallback
     was in `llm.js` mode `classify`** — the *other* sanctioned way an LLM feeds a decision (§11.7) —
     and is fixed with the same shared `pickCategory()`.
  4. **A `null` extracted field decided via the catch-all.** `llm` mode `extract` states in its own
     system prompt that *"if a field cannot be found, its value is null"* — so **the one producer the
     converger is taught to put in front of a table** emits precisely the value `readInput` did not
     catch (it checked `undefined` only), and a `null` matches only `-`. The table decided on a value
     nobody supplied — which `readInput`'s own docblock already forbade in those words.
  5. **A `from` the validator ACCEPTS must be one the engine can RESOLVE.** `from` is a REFERENCE, not
     a template, and `_runNode` was substituting it — so `from: "{{think.output}}"` arrived as the
     prose itself and the engine went hunting for a step named after it. **Verbatim the `branch.on`
     crash** (increment B), one increment later, in the one other place a reference lives. `inputs`
     now stay RAW, like `foreach.steps` and `branch.on`. (`<id>.output` also now means the step's
     output, the spelling every other reference in the system uses, instead of a field named "output".)
  6. **The engine and the analyser read one condition two ways.** `coveredAtoms` compared an enum
     literal **case-sensitively**; `matchesCondition` compares it **case-insensitively**. So
     `when: {tone: "URGENT"}` was a condition the engine evaluates happily and the analyser called
     *unreadable* — a hard publish error whose message ("isn't a condition this system can check") was
     simply untrue. This file's own header says the day the two halves disagree is the day the proof
     describes a program nobody is running. (Also: a comma list silently dropped its undeclared
     members, so `"urgent, bogus"` covered half of what its author wrote while the same typo *alone*
     was correctly an error. A rule is unreadable if ANY part of it is.)
  - **Two of the guards written in the FIX then SURVIVED the curated mutation-guard** — deletable with
    the whole suite still green. **Mutation-test the guards you add in the fix, not just the ones you
    started with.** Fifth occurrence of that exact lesson; it is now 35 curated mutations, all killed.

- **Multiple destinations — a delivery's return value is a RECEIPT, not the work product
  (2026-07-14).** Surfaced by a load-bearing test and reported as *"the workflow only did the Slack
  send"*. The report's premise was wrong in an instructive way, and re-grounding it before writing the
  brief is the only reason the right thing got fixed:
  - **The engine DOES fan out.** One `deliver` per destination, each edged from the content step; both
    run. That was never broken, and `prompts.js` has always taught it.
  - **What broke is what the SECOND destination received.** `deliver` was in `_node-input.js`'s
    `NON_CONTENT_TYPES` (so an `llm` never ingests a receipt) but **not** in `flow-tester.js`'s
    `CONTROL_TYPES`, which is the set that governs `lastOutput`. So the first delivery's receipt
    (`{delivered, ts}`) became `lastOutput`, and the second `deliver` — which builds its body from
    `ctx.lastOutput` — **shipped the first one's receipt to the customer**: Slack got the summary,
    Gmail got `{"delivered":true,"ts":"…"}`. With `run_completed`, no error, and the run marked
    success. From outside it looks exactly like *"only the Slack one worked"*.
  - **It also means `run.output` has been the last channel's receipt all along** — which is what the
    console shows, what the Inbox stores, and what `output-validator.js` inspects for an empty body or
    a leaked template. Those checks have been reading the wrong thing; `EMPTY_BODY` could never fire
    correctly. Fixing `lastOutput` fixes them by construction.
  - Fix: **`deliver` joins `CONTROL_TYPES`** — fourth member, same class as `branch`/`human`/`decision`.
    The receipt is not deleted, it is simply not the work product: the deliver node's own
    `step_completed` still carries the `ts`, which is what the **P3 gate** reads to prove runnability
    (it reads `step_completed`, not `run_completed` — checked before touching it).
  - `tests/workflows/fan-out.test.js` (new, in the gate + both mutation lists) **asserts what each
    destination RECEIVED**, not that a delivery ran — a test that only checks "two deliveries happened"
    passes on the broken engine. The defect is *asymmetric* (destination #1 is always fine), so the
    suite also runs the edges in the reverse order and with three destinations.
  - **The other half of the original report — the converger DROPPING a requested destination — is
    Increment C's defect #1 and is already closed** (`UNSATISFIED_ASSERTION`: a spec that promises
    email and doesn't send it does not publish). Pinned by the same new suite so it cannot come back.

- **Schema-aware connectors + the example picker (2026-07-14, P12 increment F)** — the write story
  died at *"paste your Airtable base ID"*. F reads the destination instead of asking for it.
  - **The last OPEN config hole is closed.** `connector-action` was the only node type on
    `configPolicy: 'open'` — its params passed straight to the handler unchecked, so a hallucinated
    `tableName` (Airtable's REST API really has one) shipped, the handler ignored it, and the record
    went nowhere the user intended. Nothing needed inventing: **every capability already declared a
    `configSchema`** and it was simply never consulted. The key set is now the node's own keys ∪ the
    SELECTED CAPABILITY's params, resolved by the same function `deliver` uses — so they cannot
    disagree about whether `baseId` is real. Plus `UNKNOWN_CONNECTOR_ACTION` (an action id that does
    not exist was a 6am run-time throw) and **required capability params** (an
    `airtable_create_record` with no `baseId` cannot run, and used to publish clean).
  - **The check SKIPS when the capability cannot be resolved** (no registry ⇒ its key set is
    UNKNOWABLE, and an unknowable key set is not a wrong one). That is safe only because the **gap
    scorer fails closed** there (`CHANNELS_UNVERIFIED`). Skipping where it cannot run and failing
    closed where it cannot check is what keeps `complete ⇒ publishable` true.
  - **New capabilities:** `airtable_list_bases`, `airtable_describe_base` (field names, types, and a
    select's closed `choices` — a decision table can take its enum straight from the system of
    record), `sheets_describe` (tabs + header rows). **The `schema.bases:read` scope has been
    requested since the Airtable connector shipped and used by NOTHING** — every tenant who connected
    Airtable already consented, so this needed no re-auth and no migration. The door was built and
    nobody opened it.
  - **`{{step.field}}` — sub-field templates (ENGINE + VALIDATOR).** Without them there was **no
    correct way to write a record at all**: an Airtable record is a map of column → value, each value
    from a different part of the upstream extract, and with only `{{extract.output}}` the sole
    expressible spec put the **whole JSON blob into every column**. The only way to write real
    per-column values was a JSON-STRING `fields`, which let a model choose the column names at RUN
    time — where **Airtable silently discards the ones that do not exist**. So the grammar was widened
    and `UNCHECKABLE_WRITE_FIELDS` now refuses the uncheckable shape. *(This is why the "dotted
    sub-fields are not supported" gotcha below is now corrected rather than deleted.)*
  - **A WORKFLOW NEED NOT DELIVER.** `MISSING_DELIVER` counted `type === 'deliver'` and nothing else,
    so *"inbound email → extract → create the record"* was rejected unless a pointless delivery was
    bolted on. **The record IS the outcome.** Same failure as the five-item checklist that made the
    converger invent an LLM step for a two-step workflow (defect #4). The rule is now "the workflow
    has an EFFECT", answered by `isWriteNode` — which already recurses into `foreach`. *(Raised by the
    operator. It also killed the reasoning that made gap-scorer's `routed` filter an "equivalent"
    mutant: a write-only workflow has no `deliver`, so the connector-action arm of it is load-bearing.)*

  **The review pair found NINE defects in F, and BOTH headline features were broken (round 2).**
  1. **THE EXAMPLE PICKER NEVER RAN — in any session.** `examples` was the SECOND node in the graph
     and `propose` is the only node that ever put a trigger in the draft, so `fetchRealExamples` read
     `triggers: []` **every single time** and fell back to modelled cases **always**. "No typed
     example" never once happened. Fixed by deriving the trigger in `process` (a trigger IS part of
     the graph it backward-chains) and running `examples` after it. **converger-v2 §2.1's order
     (outcome → examples → process) is corrected to outcome → process → examples.**
  2. **WHEN THE COLUMN MAPPING WORKED, THE SPEC COULD NOT BE SAVED.** `destinations` rewrote the
     NODE's columns and nothing rewrote `outcome.assertions[].fields` — so the node wrote `Deal Size`,
     the contract still demanded `Budget`, and `UNSATISFIED_ASSERTION` blocked publish. **`complete ⇒
     publishable` was FALSE precisely when the increment did its job** — the C blocker, reintroduced
     by F's own headline feature. The mapper now returns a **rename map** and the contract is restated
     in the table's own words. A promise with no real column is **not deleted** — it stays, fails
     loudly, and the user is told which column their table lacks.
  3. **A `foreach` LAUNDERED EVERY CHECK F ADDED.** The validator's loop walks `spec.nodes`; a loop's
     steps live in `config.steps`. A connector-action inside a loop took a nonexistent action id, a
     hallucinated param, a missing `tableId` and the dead `model` key — and validated **clean**.
     **Newly reachable because F's own prompt teaches `foreach` for the first time**, with the example
     *"create a record for every row"* — precisely the node whose params F had just started checking.
     **Fourth time this exact laundering hop has been the defect.** Fixed with `_checkNodeConfig` —
     ONE method, called for a top-level node and a sub-step alike. **A check on a node's config is a
     check on EVERY node's config, wherever the node lives.**
  4. The **outcome oracle was blind inside a `foreach`**, so the shape F *teaches* could not satisfy
     its own `record_exists` assertion and could not publish. A loop is not an opaque box; it is N
     copies of what is inside it.
  5. **`isResolvedId` accepted a plausible hallucination.** An LLM asked for an id it cannot know does
     not emit `appXXXXXXXXXXXXXX` — it emits `appABCDEFGHIJKLMN`, which passes any shape test. And the
     whole `destinations` node was gated on that test, so **one guess skipped the base lookup, the
     table lookup AND the column mapping.** A shape test cannot answer this; **only the LIST can**.
  6. **A TOTAL column mismatch shipped verbatim** while a partial one was corrected — the worst case
     took the only path with no defence, which is the shape of every defect in this phase.
  7. **Every gap arrived with an EMPTY BOX.** `buildGapPrompt` listed gaps as "1., 2." and then asked
     the model to answer keyed by `gapId` — a string it had never been shown. So no suggestion could
     ever be matched, the paid call was discarded, and **a blocking gap was never routed back through
     the propose loop**: "Accept all defaults" could not resolve a blocker. The one surface that makes
     v2's extra rigour affordable was inert. *(Pre-existing since C.)*
  8. **Three Slack schemas lied about REQUIREDNESS** (`slack_file.content`, `slack_topic.topic`,
     `slack_reminder.text` all default from the upstream body), so F's new required-param check
     **rejected shapes that run perfectly** — "summarize the thread and upload it as a file" stopped
     publishing. **A schema that lies about requiredness rejects real workflows**: the Increment C
     failure through a new door. Fixed in the SCHEMAS, not the check.
  9. A **TRIGGER capability passed as an action id** (`gmail_new_message` has no handler — existing ≠
     runnable), and **`tests/helpers/catalog.js` omitted `in_app`**, the DEFAULT delivery channel, so
     every suite using it was blind to the commonest delivery in the product — flaw #2 living inside
     the helper written to fix flaw #2.
  - **The flagship's own fixture was wrong, and green.** `write-shaped.test.js` wrote
    `{{extract.output}}` into every column — the whole JSON blob in each — and passed, because it
    asserted the KEY was right and **never looked at the VALUE**. That is the "assert what it SENT,
    not that it ran" lesson, sitting in the acceptance test for the increment whose entire purpose is
    that defect.
  - `mutation-sweep` TARGETS **widened to `src/converger/elicitation-graph.js`** — the destination
    resolution, the column mapping and the example picker: **F by line count, and its mutation score
    was "NOT MEASURED".** Four of the nine defects lived there. **A file the sweep does not target is
    a file whose absence from the survivor list proves nothing.** 49 curated mutations, all killed.

## Support tickets (in-app feedback / bug reporting) — added 2026-07-08

Users submit bugs/ideas/requests from a floating **Feedback** button in the operator
app; the team triages in the admin app and hands off to a coding agent (Markdown brief
or one-click GitHub issue). New code: `src/support/{ticket-store.js,ticket-brief.js}`,
`src/api/tickets.js` (`POST /api/tickets`, mounted in `server.js`), admin routes +
Tickets view in `src/admin/{server.js,index.html}`, and the widget + a JS-error/failed-
fetch ring buffer (`window.__atlasDiag`) in `public/index.html` (+ vendored
`public/html2canvas.min.js`). `TicketStore` is its own SQLite (`./memory/tickets/`),
fail-closed on tenant for writes; admin reads are cross-tenant by design (platform-admin
gated). Optional env (`SUPPORT_EMAIL`, `SUPPORT_SLACK_CHANNEL`, `GITHUB_REPO`,
`GITHUB_TOKEN`) — feature works storing-only without them. Full design:
[`docs/support-tickets.md`](docs/support-tickets.md). NOT the same as the dead-wired
`src/workflows/feedback-store.js` (per-run feedback).

## Pilot pricing / tier gating — reworked 2026-07-09

The flat $149/mo pilot price is replaced by a **volume-based adoption ladder** —
**Solo $20 (1 workflow / 30 runs)** → Professional $50 (10 / 200) → Team $200 (50 / 1,000)
→ Business $600 (∞ / 5,000). The **loud constraint is `activeWorkflows`** (1 on Solo): the
publish gate (`POST /api/builder/workflows`) blocks the 2nd live workflow with a 402
`PLAN_LIMIT`, which the UI turns into an immediate Upgrade modal. `monthlyRuns` is a **hard**
per-tenant/month cap enforced at the single `WorkflowScheduler._executeFlow` choke point
(`registerRunBudgetCheck`, fail-open); **test runs are exempt** (they never count or block).
Tiering is **volume-only — no feature-matrix gating** (every feature on every plan). Upgrade is
**real Stripe Checkout** (`src/billing/stripe.js`, routes `/api/billing/checkout|portal` +
`/webhooks/stripe`), env-driven and **fails soft with no keys** (app boots; checkout 503s).

Salvage/engine files touched (recorded intentional edits): `src/entitlements/index.js` (new
`PLANS`/`PLAN_META`/`nextPlan`/`entitlementsFor`), `src/auth/tenant-store.js` (new plan enum,
default `solo`, `stripe_*` columns, `setStripeIds`/`getByStripeCustomer`, **one-time grandfather
migration** → existing tenants become unlimited `founding`, marker-guarded), and
`src/workflows/workflow-store.js` (`countActiveForTenant`, `tenant_run_counter` +
increment in `startRun` non-test, `getRunCount`), `src/workflows/workflow-scheduler.js`
(`registerRunBudgetCheck`). New tenants default to `solo`; existing pilots are grandfathered.
Full design + acceptance tests: [`docs/architecture/tier-gating.md`](docs/architecture/tier-gating.md).
Stripe env vars in `.env.example`; set them on the box to enable checkout.

## The frozen canonical spec

Phase 3's correctness criterion is "the converger reproduces *this exact*
hand-authored spec." When Phase 2 produces a runnable "UPS email → Slack" spec,
it is frozen at `docs/specs/canonical-ups-slack.json`, committed, and **never
regenerated**. The converger is built against that fixed target. (File appears in
Phase 2; this pointer marks where it lives.)

**Recorded decision (2026-06-12): "exact" means structurally equivalent AND
provably runnable, not byte-for-byte LLM output identity.** The converger is
non-deterministic — requiring identical field values (node IDs, filter text,
config wording) would be brittle and would defeat the purpose of an elicitation
engine. The gate therefore verifies:
  1. Structural equivalence: correct trigger type (`email`), UPS filter, a
     summarize-type node, a delivery-type node targeting Slack, and an edge
     connecting them.
  2. Runnability: the converger's emitted spec runs through the execution engine
     end-to-end (mock email → summarize → stub Slack) and returns a delivery `ts`
     — the same runnability bar Phase 2 proved for the hand-authored spec.
This is a stronger check than byte-for-byte comparison because it proves the
spec is actually executable, not just structurally similar to the frozen file.

## Known gotchas

- **Delivery nodes need context-aware output formatting (unbuilt, P10+).** The
  `deliver` node and connector-action delivery capabilities pass output through as-is,
  with no awareness of the target channel's format requirements. The Airtable
  announcement workflow is the canonical broken example: the LLM emits HTML and the
  email delivery sends it verbatim, so recipients see raw `<p>` and `<br>` tags instead
  of formatted text. Each delivery channel needs its own output transform: email should
  render HTML properly (set Content-Type text/html) or strip tags to plain text; Slack
  should convert to mrkdwn; SMS/webhooks should strip all markup. Fix belongs in each
  capability's `handle` in `src/connectors/*/index.js`, not in the LLM prompt.

- **The node library is `trigger · llm · assemble · connector-action · search_web · deliver`, plus
  the control-flow types `branch · foreach · human · decision` (P12 increments A + B + E,
  2026-07-13/14).** `tool` / `mcp_tool` / `fetch` **no longer exist** — they were
  deleted, and the validator now rejects them by name (`REMOVED_NODE_TYPE`). They were never
  runnable: there is no `ToolRegistry` (no `src/tools/`, never instantiated) and `FlowTester` is
  built without `tools`, so they threw at run time; now they fail at build time instead.
  `summarize` / `extract` / `rewrite` are **`llm` with a `mode`**, and `daily_digest` is
  **`assemble`**. Old specs still validate and run — `node-types/compat-v1.js` lifts them on read
  (nothing in the DB was migrated), so **you will still see v1 types in the database and in the
  store; that is expected, not a bug.** Filesystem capabilities (`filesystem_read`,
  `filesystem_list`) surface automatically in connector-action options via
  CapabilityRegistry/ChannelRegistry.

- **A node's config keys are checked against its `configSchema` (`UNKNOWN_CONFIG_KEY`), so an
  undeclared key is now a hard error.** If you add a config key that a node's `run()` reads, you
  **must** declare it in that type's `configSchema` or every spec using it stops validating. The
  check is scoped by `configPolicy` — `'closed'` (the default, subset enforced) vs `'open'`
  (`connector-action` only, whose params are per-capability). The inverse is just as important:
  **never declare a key `run()` doesn't consume** to make a spec pass — a schema that lists keys
  nothing reads turns the check into theatre, which is exactly the state that let
  `"model": "claude-opus-4-5"` ship. (2026-07-13)
- **`/workflows/run` returns 200 with `{completed:false, error}` for a failed step**, not a
  5xx — Cloudflare replaces origin 502/504 with its own HTML error page, which hid the real
  run error behind a "tunnel/proxy" message. Application-level run failures must stay 2xx so
  the UI can read them. (2026-06-18)
- **Dev event log:** `src/utils/event-log.js` appends JSON-lines to
  `./memory/logs/atlas-events.log` (gitignored) — one line per HTTP request plus
  run/chat/session/persist lifecycle events. Tail/grep it to see exactly where a
  conversation or run broke. The pretty console `logger.js` is separate (terminal only).
- **`.env` is not auto-loaded.** `src/api/server.js` has no dotenv; `npm start` runs
  `node --env-file-if-exists=.env src/api/server.js` (fixed 2026-06-17). Running the
  server with a bare `node src/api/server.js` leaves `ANTHROPIC_API_KEY` unset, so
  `buildLLM()` silently falls back to the **local llama model** — the symptom is "inference
  is using local even though Anthropic is in the codebase." Always launch via `npm start`
  (or pass `--env-file`).


- **`sc-if` / `sc-for` template elements are visible DOM nodes before support.js runs
  (2026-06-25).** The DC framework compiles them at runtime, but before that they are
  unknown HTML elements defaulting to `display:inline` — the browser computes inline
  styles for their children, including fetching `background:url(...)` values containing
  unresolved template variables (e.g., `url('{{ c.logo }}')` → 404). Fix: a global CSS
  rule `sc-if, sc-for { display: none; }` added to `<style>` in `public/index.html`
  prevents child-style computation before the framework runs. **Do not use `<img src="{{...}}">`
  or `background:url('{{...}}')` inside template elements without this CSS guard.**

- **Chat `parsed:false` when tools are active (2026-06-25).** The chat endpoint
  (`src/api/builder.js` → `POST /api/builder/chat`) passes connector tools to the LLM
  whenever a connector is connected. With `tools` in the invocation, Claude sometimes
  returns natural prose instead of the required JSON envelope, even when the system prompt
  specifies JSON. Root cause: tool-use mode changes the model's response routing. Fix:
  when `chatTools.length > 0`, append a short JSON format reminder to the last user
  message in `msgArray` — the most salient position immediately before the model's turn.
  This is structural (applies to every tool-equipped turn), not hardcoded to any connector.

- **LLM-backed capabilities must receive `sessionId` for cost attribution (2026-06-26).**
  The CostTracker resolves `tenant_id` from `user_id`, and `user_id` from the
  session→user map (`setSessionUser`). Any capability that makes its own LLM call
  (today: `web_search` → native Anthropic `web_search_20260209`) must be handed the
  caller's `sessionId` so its cost record resolves to a tenant. The engine path does
  this (`node-types/connector-action.js` passes `sessionId`/`costContext` from
  `costConfig`); the **chat** path (`builder.js` `makeChatToolExecutor`) originally did
  not, so every chat-invoked web search logged with `session='unknown'`,
  `tenant_id=NULL` — orphaned from per-tenant cost aggregates (37% of platform spend at
  the time). Fix: `makeChatToolExecutor(spine, req, chatSessionId)` threads `sessionId`
  into `handler({ ..., sessionId })`; `costContext` is left undefined so each capability
  self-labels (web_search → `'web_search'`, keeping the cost-by-surface view honest).
  **Rule: any new surface that invokes an LLM-backed capability outside the engine must
  thread `sessionId`.** Per-tenant aggregates (lifetime / est. monthly / activity) read
  `llm_cost_log` with no context/test filter, so they include everything *that is
  attributed* — attribution is the only thing that can drop a call from a tenant's totals.

- **Slug collision on re-publish (2026-06-25).** `WorkflowStore.create()` now
  auto-deduplicates slugs: probes `(tenant_id, user_id, slug)` and appends `-2`, `-3`,
  etc. until a free slot is found before inserting. Prevents `UNIQUE constraint failed`
  when the same workflow name is published more than once.

- **`server.js` encoding.** In `agntic-prod`, `src/api/server.js` reads as
  `data` to `file` and plain `grep` returns zero matches — it once convinced an
  agent the engine was deleted. **Root cause (verified):** the file is valid
  UTF-8 with *no* BOM; it holds a single literal NUL byte (`\x00`) at offset
  ~20198, inside a session-key template string `u:${userId}\x00${rawSessionId}`.
  That one NUL makes macOS `grep` stop early. Fix = replace/remove that NUL, not
  a re-encode. Until then use `grep -a` / `perl`. (P0 builds a *new* minimal
  server.js, so this only bites when copying logic out of the salvage file.)
  Full map: [`docs/salvage-map.md`](docs/salvage-map.md).

## Production & deploying (the pilot is LIVE)

Atlas runs in production at **https://atlas.agntic.co** — a single Node process
(`systemd` unit `atlas`) behind a Cloudflare Tunnel (`cloudflared`) on an **AWS
Lightsail** box (Ubuntu, static IP **`YOUR_SERVER_IP`**). The app lives at
`/home/atlas/atlas`, owned by the `atlas` service account. You **SSH in as `ubuntu`**
(Lightsail's default — there is no `atlas` SSH login) and **`sudo -u atlas`** to act
as the run user. Secrets live in `/home/atlas/atlas/.env` **on the box** (gitignored,
never committed); the operator manages them — agents never enter or echo secret values.

**Shipping a change to prod** (full protocol + rollback:
[`docs/deployment/update-protocol.md`](docs/deployment/update-protocol.md)):

1. **Bump the version** — every prod push moves `package.json` (the single source of
   truth for `/health` + the What's-New modal): `./scripts/release.sh patch` (silent)
   or `./scripts/release.sh patch --title "…" "user-facing note"` (adds a What's-New
   entry shown once per user on next login). Stages the change to commit *with* the code.
2. **Commit + push `main`** (conventional message + `Phase:` trailer). If the push is
   rejected because a parallel session pushed first, `git pull --rebase origin main`
   then push — never force.
3. **Deploy on the box** (pulls `main`, `npm ci`, restarts `atlas`, polls `/health`):
   ```bash
   ssh ubuntu@YOUR_SERVER_IP 'sudo -u atlas -H bash -c "cd /home/atlas/atlas && ./scripts/deploy.sh"'
   ```
4. **Verify** — `curl -s https://atlas.agntic.co/health` shows the new `version`, then
   eyeball the change (hard-refresh for frontend). A deploy is not done until the
   restarted process serves the new code. `deploy.sh` prints the exact rollback SHA on
   failure.

Deploying is outward-facing: do it only when the operator asks. Committing/pushing to
`main` does **not** auto-deploy — prod only changes when `deploy.sh` runs on the box.

## Working rules

- **One deliverable per session, ending at a gate.** Rehydrate from this file +
  the module map, not from scrollback. Don't span a phase boundary in one session.
- **The doc is the memory — keep it true, in the same commit.** Fresh sessions only
  work because the *documents* carry state, not the agent's context. So: if your work
  contradicts a design doc or this file, **fix the doc in the same commit as the code**.
  Never leave a correct implementation next to a stale spec. The next session rehydrates
  from that spec and will build on the lie — which is the same stale-brief failure that
  costs a full round every time it happens. A design doc that disagrees with `main` is
  worse than no doc: it is *confidently* wrong, and it reads as authoritative.
  Corollary: if the code is right and the doc is wrong, that is a **doc bug**, and it is
  yours to fix — not a note to leave for someone else.
- **Close a phase before starting the next.** A phase is *closed* only when its
  gate-verified work is **merged to `main`** — not merely "gate passed" or "PR
  opened". Do not begin (or branch) phase N+1 until phase N is merged; branch the
  next phase from `main`, never from an unmerged PR.
- **Evidence-gating (load-bearing).** No agent may report something missing,
  broken, or deleted without a file path + line range, or the exact command that
  returned nothing. Negative claims need proof of absence, not absence of proof.
- **Fresh Verifier at every gate.** A gate is closed by an agent that did *not*
  write the code, with a passing check. Record it with `Gate:` + `Verified-by:`
  in the commit.
- **Don't parallelize the converger.** Phases 0–3 + the spine are serial.
  Worktree-isolate only the independent connectors and the greenfield UI surfaces.

## The verification system had an architectural flaw. Three, actually. (2026-07-13)

P12 Increment B failed independent verification **seven times**, ~20 real defects, and **every
single one reached candidate state behind a fully green suite**. That is not bad luck or
sloppiness — it is three structural holes, and they are worth naming because they apply to every
phase, not just this one.

1. **The gate measured the EXISTENCE of tests, not their POWER.** `p12.sh` checked that a test
   file exists, that it passes, and grepped the validator for symbol names. **A suite of 70 tests
   that cannot fail satisfies that perfectly.** So "gate green" and "code correct" were only weakly
   correlated — which is exactly what seven rounds demonstrated.
   → **Fixed:** `scripts/checks/mutation-guard.mjs` re-introduces each historical defect and
   requires the suite to FAIL. It runs **inside the gate**. A guard whose mutation survives is a
   guard nothing pins, and the next person can delete it with the gate still smiling. It earned
   its keep on its first run, immediately finding a survivor.

2. **The tests exercised a configuration production never uses.** Every idempotency test
   constructed `FlowTester` directly and hand-passed a `workflowId` that **no production caller
   passed** — so the scope silently degraded to `unscoped:<nodeId>` in a store with no tenant
   column, and one tenant's step was handed **another tenant's output**. A unit test on the engine
   **cannot see that class of bug by construction**: the mutant and the original behave identically
   when the test supplies what production omits.
   → **Fixed two ways:** the scope is now **fail-closed** (no `?? 'unscoped'` — a step that cannot
   be scoped refuses to run), and `control-flow.test.js` asserts the **production call path**
   (what the scheduler and the REST route actually pass), hand-passing nothing.
   **Rule: a `??` default on a security-relevant value is not a safety net — it is the bug.**

3. **The builder writes both the code and the tests**, so they share blind spots. Mutation testing
   was meant to break that, but the builder also chose the mutations — and twice published a false
   score ("7/7", "11/11") that an independent verifier falsified by writing a wider list. **A
   self-authored mutation score is a tautology**: you can only mutate what you already thought of,
   which is exactly what you already wrote tests for.
   → **Fixed, both halves:**
   - *Mechanically* — `scripts/checks/mutation-sweep.mjs` **generates** mutants across the engine
     (every `if` → `true`/`false`, every `??` → no default, every `throw` → swallowed). The builder
     is out of the loop: you cannot omit a mutation you did not think of when you are not choosing
     them. It found real holes the curated list never touched — an untested `escalate` flag, the
     untested branch/`foreach` throws, untested JSON-string paths. It runs **in the gate** with a
     kill-rate **ratchet** (raise it, never lower it). The **survivor list is the coverage report**.
   - *In process* — the new **`test-adversary`** agent (`.claude/agents/test-adversary.md`) writes
     the pinning tests. It may write `tests/` and `scripts/checks/` and **must not touch `src/`**:
     if a test cannot pass without a source change, that is a finding, reported and left failing.
     **Spawn it after every Builder increment, before the verifier.** The Builder no longer grades
     his own homework.

**The one-line lesson: a green suite is evidence of nothing until you have watched it go red.**

**Residual for a future increment (from the round-9 readiness verifier, non-blocking):**
~~`mutation-sweep.mjs` `TARGETS` covers `flow-tester` / `branch` / `foreach` / `human` /
`idempotency-store` but **not** `workflow-validator.js`, `workflow-store.js`, or
`workflow-scheduler.js`.~~ **CLOSED by increment D** for the validator (C) and the scheduler (D).
`workflow-store.js` is **still not in TARGETS** — carry it forward.

### The residual ledger — carried into E (recorded, not forgotten)

*Inherited from C, still open:*
- ~~**`decision-analysis.js` is unreachable from any publishable spec.**~~ **CLOSED by increment E**:
  `decision` is a registered node type, the analysis runs at publish (`_checkDecisionTables`) as well
  as in the converger, and the engine honours it (an uncovered case throws).
- **`assertion.when` is carried but NOT proven** (§2.2) — a conditional assertion raises a
  non-blocking `CONDITIONAL_UNPROVEN` gap. **D now materialises that gap into a real `human` gate**
  (`escalation.js`), which is an honest *escalation* of the condition — but it is still not a
  *proof*. Proving it needs `decision` (E) + the examples as a test suite (G).
- ~~**The `connector-action` config hole**~~ — **CLOSED by increment F.** Nothing is `configPolicy:
  'open'` any more: a connector-action's params are validated against the SELECTED CAPABILITY's own
  declared schema, by the same resolver `deliver` uses for its channel.

*New, from F (the verifier's round-2 residuals — recorded, none blocking):*
- **A LATCH THAT STOPS YOU ASKING MUST NEVER STOP YOU CHECKING.** The round-2 blocker:
  `destinations` resolved the columns once, `applyProposal` REPLACES a node by id, and a blocking
  gap routes back through `propose` — so any later propose round could put the invented column
  straight back, and nothing re-checked it. **The gap loop even hands the model the motive**: the
  blocking gap says *"you promised Company and nothing writes it"*, so the model obligingly
  re-proposes the node with `Company` back on. The increment's own honest-failure path, converted
  into a silent success by the loop that reported it. **A fact the next node can falsify is not an
  invariant, it is a memory.** Fixed by caching the resolved destination (ask once) and
  RE-CHECKING the columns on every pass (free — it reads state). **Mutation testing could not have
  found this: there was no line to mutate. It was a MISSING re-check, and the sweep measures the
  guards you wrote, never the one you didn't.**
- **`{{item.naem}}` inside a `foreach` is unchecked** — it publishes, writes the column blank, and
  says nothing. The item's shape is genuinely unknowable at build time, so this is consistent with
  `BAD_TEMPLATE_FIELD`'s rule ("a source that declares nothing makes no claim") — but it is the same
  silent-blank-column class, in the canonical bulk-write shape. Same for `{{look.subject}}` off a
  connector read: **capabilities declare no OUTPUT schema**. Closing both needs output schemas on the
  catalog — worth doing, and the natural home is G or a connector increment.
- **`fields: {}` publishes when the assertion carries no `fields` array.** `fillDestination`'s
  docstring claims a total mismatch "fails UNSATISFIED_ASSERTION" — true only if the model put a
  `fields` array on the assertion. Otherwise it publishes and fails loudly at every run on
  `airtableCreateRecord`'s empty-record guard. **The docstring over-claims; the behaviour is loud.**
- `tests/workflows/validator-rules.test.js:42-52` still hand-rolls a `CHANNELS` map instead of using
  `tests/helpers/catalog.js`.

*New, from E:*
- ~~**A decision's `from` is not checked against what the upstream step produces.**~~ **CLOSED by
  increment F** — `BAD_TEMPLATE_FIELD`. F's sub-field grammar ({{extract.budget}}) is what makes a
  correct record expressible at all, and it WIDENED the silent-failure surface it was meant to close:
  a typo'd `{{extract.budgett}}` resolved to an EMPTY STRING, so the column was written blank and the
  run reported success. An `llm` in `extract` mode DECLARES its field names, so the typo is knowable
  at build time and is now a build error. Where the source declares nothing (a connector read, a
  freeform llm), its shape is genuinely unknown and **no claim is made** — an unknowable field name is
  not a wrong one.
- **The `decision_review` UI edits cells, `then`s and the hit policy — it cannot ADD or DELETE a rule.**
  Deliberate for E (the table is *reviewed*, not *authored* — §6.2.5, and the gap review is where a
  missing case gets answered), but a user who spots a rule that should not exist has to say so in chat.
- **No `DECISION_ANSWER_NOT_ROUTED`.** A `decision` nothing routes on is inert — the run completes, the
  draft is delivered, and the decision is simply ignored. Judged NOT a defect (unlike a `human`, a
  decision does not *claim* to gate, and its value is legitimately usable in a template), but recorded
  because `prompts.js` teaches decision→branch and the silent-no-op class is exactly what this phase
  exists to kill. Revisit if a real workflow ever ships one.
- **`decision-analysis.js` holds the FEEL-A grammar in TWO functions** (`coveredAtoms` for the proof,
  `matchesCondition` for the engine). They have now disagreed **twice** — on case-sensitivity (defect
  #6) and on undeclared enum literals (E-R10: the analyser called `"bogus"` unreadable while the engine
  read `not(bogus)` as matching *everything*). Both are fixed and both are mutation-guarded, but they
  are still two functions, and every future divergence is a coverage proof about a program nobody runs.
  **Collapse them into one when F touches the analyser.**
- **`pickCategory` refuses a preambled answer when one declared value CONTAINS another**
  (`['review','needs review']` + *"Decision: needs review"* → two word-boundary hits → ambiguous →
  throw). Fail-closed and loud, so it escalates rather than misclassifies — but the exact answer works
  and the preambled one does not. Recorded, not fixed: guessing between two declared values the model
  arguably named is the very thing that made the old fallback dangerous.
- **`tests/e2e/onboarding.test.js` has ~5 failing tests at baseline** (workspace provisioning, slug
  dedupe, team invites, seat limits) — **pre-existing, unrelated to P12, and NOT in any gate's list**.
  Confirmed by the test-adversary and the verifier independently, on a clean tree. They also flake
  (one run showed 6). Someone should own these; they are a broken window in the E2E suite.

**⚠️ PROCESS HAZARD, found by the verifier (2026-07-14): do NOT run the test-adversary and the verifier
in parallel if BOTH are told to run `mutation-sweep`.** The sweep rewrites `src/` in place, so one
agent's sweep corrupts the other's results **in both directions** — the verifier caught a live mutant
(`const cfg = node.config};`) in its working tree mid-run and had to discard and re-derive every
finding on a clean tree. CLAUDE.md already says "run it in the FOREGROUND"; that is necessary and not
sufficient. **Exactly ONE agent may run the sweep per round** (give it to the adversary, whose job is
the survivor list), and the other must be told explicitly not to. Parallelism is still right — they are
read-only w.r.t. `src/` in every other respect — but the sweep is a WRITE.

*New, from D:*
- **`workflow-store.js` is still not in `mutation-sweep` TARGETS.** D touched it (the pause deadline
  columns, `getAwaitingHuman`, `listExpiredPauses`, the `markRunResumed` latch). Those are pinned by
  `tests/approvals/*` and the curated `mutation-guard`, but not by the *generated* sweep. Widen it
  when E touches the store.
- **`quorum` appears in converger-v2 §7.1's node shape and does not exist.** It is *not* a silent
  no-op — increment A's `UNKNOWN_CONFIG_KEY` rejects it at publish (verified: a `human` node with
  `quorum: 2` fails validation), which is the check doing precisely its job. So the defect is in the
  **DOC**, which shows a key the engine has no schema for: anyone building from §7.1 verbatim writes
  a spec that will not save. Either implement quorum (a second answer, a second answerer, and a rule
  for what happens when they disagree) or **cut it from §7.1**. Today the FIRST valid answer wins,
  and that is all.
- **The Slack ask is posted, but never UPDATED on a timeout.** If nobody answers and the sweeper
  resolves the pause, the Block Kit message still sits in `#ops` with live-looking buttons. Clicking
  one is refused correctly ("that question has already been answered"), so it is not *wrong* — but it
  is a stale question in a channel, and the honest thing is to edit the message. Needs the
  `chat.update` ts, which `postSlack` already returns and nothing stores.
- ~~**R1 — the approval Slack post used `getSlackGrant(...)?.botToken`** (always undefined → posted as
  the operator), **R2 — the raw magic-link token was logged in plaintext**, and **R3 —
  `timeout.then: 'escalate'` notified nobody.**~~ **All three CLOSED in round 2** (`getSlackToken` with
  the cipher; the logger redacts `/approvals/<token>`; the sweeper calls the escalation notifier on a
  `then: 'escalate'` timeout).
- **`APPROVAL_CHANNEL_NOT_CONNECTED` cannot see the mailer from the converger's side.**
  `builder.js` computes `capabilities.approvalChannels` with `mailerConfigured()`, which is a
  *server* fact; a tenant whose deployment has no SMTP configured gets `email` correctly withheld.
  But the check is deployment-wide, not per-tenant — there is no per-tenant mail identity yet. Fine
  today (one deployment, one mailer); revisit if tenants ever bring their own sending domain.

**First run of the `test-adversary` (2026-07-13), against a suite already hardened by 8 rounds.**
It touched no `src/`, found **no live bug** (every invariant held), but pinned 8 untested *paths*
and raised the generated-sweep kill rate **69.9% → 75.0%** (floor ratcheted 0.65 → 0.72). The
headline hole was flaw 2 again: **every `foreach` test drove the loop with a literal
`JSON.stringify([...])`** — the step-reference path (`over: "rows.output"`, what every real
foreach uses: connector search → loop its rows) was *entirely unexecuted*. Correct code, zero
coverage; a regression there would have shipped green. Also newly pinned: the retry-exhaustion
event count, the already-aborted-signal path, `human` decisions as a comma-string, the
audit-trail fields, dedupe across a fresh store instance, and the resume boundary **through
`WorkflowStore`** (in-memory checkpoint tests bypassed the exact serialisation layer the original
truncation disaster lived in). One survivor left unpinned by deliberate judgment — the topo-sort
cycle/disconnected fallback (`flow-tester.js`), pre-existing salvage the validator already guards
with `CYCLE_DETECTED`; the Builder tried to pin it, got the expected behaviour wrong, and removed
the test — **the Builder overriding the adversary's scope call is itself the anti-pattern.**

## Agents & gate enforcement

The build runs with four roles. **Builder is this main session** (you), governed
by this file — not a subagent. The other three are subagents in `.claude/agents/`:

- **`scout`** — read-only explorer; fan out for "where does X live", returns
  conclusions with `file:line`, never edits.
- **`verifier`** — fresh, independent gate checker; did *not* write the code.
- **`adversary`** — Phase 3 only; tries to break the converger.

**Gates are HARD (fail-closed).** A phase closes only through its check:

- Each phase's objective "Done when" lives in `scripts/gates/p<phase>.sh`
  (run via `scripts/gate.sh <phase>`). They ship fail-closed — an unimplemented
  check does not pass. Fill in the real check as you build the phase.
- Run **`/gate <phase>`** to close one: it spawns the `verifier`, which runs the
  check, reviews the artifacts with evidence, and writes `docs/gates/p<phase>.md`
  only on a real pass.
- **`.githooks/pre-push`** refuses to push any commit carrying a `Gate:` trailer
  unless that phase's check passes — so a failing gate physically blocks the
  phase from being published.
- **Never `--no-verify`.** A Claude Code `PreToolUse` hook
  (`.claude/settings.json` → `.claude/hooks/block-no-verify.sh`) blocks agents
  from bypassing the commit-msg / pre-push hooks. Don't weaken the check scripts
  to force a pass either; if a check is wrong, fix it and record why here.

### Review calibration — the INCREMENT loop (decided 2026-07-13, operator)

The apparatus above was written for **phase gates**. Applied unchanged to every
*increment*, it cost more than it bought: P12-C spent ~35 minutes of wall-clock on
review that was **duplicated work**, not extra assurance. The three rules below
buy that back. They change **when** and **how much** is re-run — they do **not**
remove the independent check, because on the one increment where the moat itself
was broken, the Builder's own suite was green and he would have merged it.

**1. The verifier BLOCKS on user-reachable, silent defects. Everything else is a
RESIDUAL.**
A defect blocks the merge iff it is **(a) reachable in production** by a user or
another tenant, **AND (b) silent** (no error is surfaced — it looks like success)
**or destructive** (data loss, cross-tenant leak, money moved). Everything else —
data hygiene, an unreachable code path, a cosmetic inconsistency — is a
**residual**, not a failure.
- The verifier must still **LIST every defect it finds**. It may never omit one
  because it isn't a blocker. Suppressing a finding to speed a merge is the
  failure mode this rule is most likely to cause, and it is forbidden.
- Residuals are **recorded in this file** with `file:line` and **carried into the
  next increment's brief**. A residual ledger is a debt ledger, not a shrug.
- *(P12-C calibration: D1 — a spec scoring `complete` that then refuses to publish
  — was correctly a blocker. D5 — a `spec_version` column left at 2 with no
  contract in it, which nothing reads and no client can reach — should have been a
  residual.)*

**2. The gate is run ONCE, by the BUILDER. The verifier does NOT re-run it.**
The Builder runs `bash scripts/gate.sh <phase>` and records **the log and the SHA
it was run at**. The verifier's job is to confirm `git rev-parse HEAD` **matches
that SHA** and that the log shows the expected stop point — not to recompute a
20-minute deterministic result. **It re-runs the gate only if the tree has moved.**
- This is not a trust concession: the gate is **hook-enforced at push** for any
  gate-closing commit, and re-running it *cannot* be a fresh signal at the same
  SHA. (It can, in fact, be a *worse* one — P3 and the converger-adversarial check
  call a live model, so a re-run can flake and burn a round on noise.)
- **What the verifier must still do itself, always:** targeted **mutation** of the
  guards the increment ADDED (~2 minutes, and it is the one thing a log cannot
  fake), plus an independent attempt to **break the increment's stated
  invariants**. That is where every real finding in this phase came from — not
  from re-running the suite.
- **The full `mutation-sweep` is the Builder's to run, not the verifier's.** The
  verifier reads its **survivor list** — which is the honest coverage report — and
  says whether the Builder read past something. *(In P12-C the sweep named the
  exact line of the blocker as a survivor, and the Builder read past it.)*

**3. `test-adversary` and `verifier` run in PARALLEL, not in series.**
Both are read-only with respect to `src/`, so they cannot race. Spawn them
together after the build.
- If the adversary finds a defect the Builder then fixes in `src/`, the verifier
  gets **the fix diff as a delta message** — it does not restart. (`SendMessage`
  resumes it with its context intact.)
- The Builder still **fixes** what the adversary finds. The adversary never
  touches `src/`; the verifier never touches `src/`.

**What did NOT change, and must not:** the verifier is fresh, independent, and did
not write the code; it may still FAIL the merge; and a gate still closes only
through its check. Velocity is bought by removing *duplication*, never by removing
*the second pair of eyes*.

## Phase status

Update as gates close. `git log --grep "^Gate:"` is the authoritative ledger.

- [x] **P0** — clean spine: engine boots in new repo, UI hits one health route
- [x] **P1** — Slack connector: clicking "run" posts to Slack
- [x] **P2** — event triggers + Gmail: hand-authored UPS→Slack fires on real email *(freeze the spec here)*
- [x] **P3** — converger reproduces the frozen spec, confirmations logged
- [x] **P4** — builder UI: workflow built entirely by talking *(design-first: Claude generates mockups → approval → build)*
- [x] **P5** — console UI: inventory, live run monitoring, SOP view + SOP export (PDF + Markdown).
- [~] **P6** — *(scrapped 2026-06-20)* current sidebar + surface switching is sufficient; floating pill / launcher layer dropped from scope.
- [x] **P7** — Airtable + Google write + error handling + sub-daily scheduling
- [x] **P8** — web research (`search_web` native Anthropic tool, already built) + filesystem connector (`filesystem_read`/`filesystem_list`, tenant-sandboxed to Knowledge-page approved folders)
- [x] **P9** — value tracking: time-saved metrics per run, all-up ROI summary, customer-facing report
- [x] **P10** — admin observability: standalone admin app, per-tenant usage + cost monitoring *(merged `601760c`; carries `Gate: P10` trailer + passing `scripts/gates/p10.sh`. Ledger backfilled by independent verifier: `docs/gates/p10.md`.)*
- [x] **P11** — E2E validation + production hardening + VPS migration. **Closed 2026-07-13** (`b711b44`, `Gate: P11`, ledger `docs/gates/p11.md`). Built & merged long before (`d73b813`…`75891b7` + artifacts `2106f71`); the gate was un-closeable only because `scripts/gates/p11.sh` fail-closes when `PROD_HOST` is unset — it cannot smoke-test a VPS that doesn't exist. Prod went live, so `PROD_HOST=atlas.agntic.co bash scripts/gate.sh 11` finally runs. **Note for anyone re-running it:** the E2E suite *self-skips the converger test* without `ANTHROPIC_API_KEY` (`tests/e2e/full-journey.test.js`), so a bare run reports "6 pass / 1 skip" and the skipped one is Done-when #1. Run it with a key (7/7) or you are passing a gate you haven't proven.
- [~] **P12** — **converger v2**: outcome contracts + BPMN/DMN shape (decisions, gap analysis) + the elicitation UI + the human approval gate. Build spec: [`docs/architecture/converger-v2.md`](docs/architecture/converger-v2.md) (theory: [`bpmn-dmn-foundations.md`](docs/architecture/bpmn-dmn-foundations.md)). Gate `scripts/gates/p12.sh` is **progressive** — it runs increments A–G in order and stops at the first unbuilt one, so `bash scripts/gate.sh 12` answers both *"is the phase closed?"* and *"which increment next?"*. **Increments A (validator hardening + node re-cut), B (engine control flow), C (converger v2 core + the outcome contract), D (the human approval gate), E (the `decision` node + DMN gap analysis + the table review UI) and F (schema-aware connectors + the example picker + `foreach` turned on) are done** — the gate now stops at **G (the zero-typing path + the SOP)**. Increments do NOT carry a `Gate:` trailer; only the phase's close does. Two invariants are load-bearing and must never be weakened: **`LLM_INPUT_NOT_ENUM`** (an LLM-evaluated decision input must classify into a *closed enum* — without it there is no completeness proof, and the completeness proof is the moat) and **`EMAIL_REPLY_APPROVAL`** (an approval parsed out of an email reply body authenticates *nothing*: `From:` is spoofable, and SPF/DKIM authenticate a sending domain, not a human intent — use a signed, hashed, single-use magic link).
