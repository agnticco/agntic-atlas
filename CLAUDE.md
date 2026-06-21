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
- **search_web in converger prompt (2026-06-21, P8)** — `src/converger/prompts.js` now lists
  `search_web` as an available node type (Anthropic native web_search_20260209, no Tavily/
  Firecrawl). Filesystem capabilities surface automatically via CapabilityRegistry → ChannelRegistry
  → `stepSummary()` with `actionOnly:true`, so no additional prompt wiring was needed.

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

- **`tool` / `mcp-tool` / `fetch` node types are NOT runnable in this build.** There is
  no `ToolRegistry` (no `src/tools/`, never instantiated), and `FlowTester` is built
  without `tools`, so a `tool`/`mcp-tool` node throws `Tool registry unavailable`; `fetch`
  needs a registered `source`, not a URL. The converger prompt
  (`src/converger/prompts.js`) is therefore restricted to the runnable set
  (summarize/llm/extract/rewrite/search_web/deliver + connector-action for registered
  capabilities + triggers). `search_web` was added in P8 (2026-06-21). Filesystem
  capabilities (`filesystem_read`, `filesystem_list`) surface automatically in
  connector-action options via CapabilityRegistry/ChannelRegistry. (2026-06-18, updated 2026-06-21)
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


- **`server.js` encoding.** In `agntic-prod`, `src/api/server.js` reads as
  `data` to `file` and plain `grep` returns zero matches — it once convinced an
  agent the engine was deleted. **Root cause (verified):** the file is valid
  UTF-8 with *no* BOM; it holds a single literal NUL byte (`\x00`) at offset
  ~20198, inside a session-key template string `u:${userId}\x00${rawSessionId}`.
  That one NUL makes macOS `grep` stop early. Fix = replace/remove that NUL, not
  a re-encode. Until then use `grep -a` / `perl`. (P0 builds a *new* minimal
  server.js, so this only bites when copying logic out of the salvage file.)
  Full map: [`docs/salvage-map.md`](docs/salvage-map.md).

## Working rules

- **One deliverable per session, ending at a gate.** Rehydrate from this file +
  the module map, not from scrollback. Don't span a phase boundary in one session.
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
- [ ] **P8** — web research (`search_web` native Anthropic tool, already built) + filesystem connector (`filesystem_read`/`filesystem_list`, tenant-sandboxed to Knowledge-page approved folders)
- [ ] **P9** — value tracking: time-saved metrics per run, all-up ROI summary, customer-facing report
- [ ] **P10** — admin observability: standalone admin app, per-tenant usage + cost monitoring
- [ ] **P11** — E2E validation + production hardening + VPS migration
