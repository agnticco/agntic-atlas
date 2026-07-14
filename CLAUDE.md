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
  the control-flow types `branch · foreach · human` (P12 increments A + B, 2026-07-13).** `tool` / `mcp_tool` / `fetch` **no longer exist** — they were
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
Lightsail** box (Ubuntu, static IP **`32.198.159.147`**). The app lives at
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
   ssh ubuntu@32.198.159.147 'sudo -u atlas -H bash -c "cd /home/atlas/atlas && ./scripts/deploy.sh"'
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
`mutation-sweep.mjs` `TARGETS` covers `flow-tester` / `branch` / `foreach` / `human` /
`idempotency-store` but **not** `workflow-validator.js`, `workflow-store.js`, or
`workflow-scheduler.js` — those surfaces are graded only by the curated `mutation-guard` +
`control-flow.test.js`, not the generated sweep. Verified by hand that the validator control-flow
rules and the store migration bite, so it is a coverage-*scope* note, not a hole. Widen `TARGETS`
when C/D touch those files (watch the floor — new files will surface equivalent-mutant survivors).

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
- [~] **P12** — **converger v2**: outcome contracts + BPMN/DMN shape (decisions, gap analysis) + the elicitation UI + the human approval gate. Build spec: [`docs/architecture/converger-v2.md`](docs/architecture/converger-v2.md) (theory: [`bpmn-dmn-foundations.md`](docs/architecture/bpmn-dmn-foundations.md)). Gate `scripts/gates/p12.sh` is **progressive** — it runs increments A–G in order and stops at the first unbuilt one, so `bash scripts/gate.sh 12` answers both *"is the phase closed?"* and *"which increment next?"*. **Increments A (validator hardening + node re-cut), B (engine control flow) and C (converger v2 core + the outcome contract) are done** — the gate now stops at **D (the human approval gate)**. Increments do NOT carry a `Gate:` trailer; only the phase's close does. Two invariants are load-bearing and must never be weakened: **`LLM_INPUT_NOT_ENUM`** (an LLM-evaluated decision input must classify into a *closed enum* — without it there is no completeness proof, and the completeness proof is the moat) and **`EMAIL_REPLY_APPROVAL`** (an approval parsed out of an email reply body authenticates *nothing*: `From:` is spoofable, and SPF/DKIM authenticate a sending domain, not a human intent — use a signed, hashed, single-use magic link).
