# Atlas — Build Constitution

Read this first, every session. It encodes the decisions that are **closed**, the
code that is **off-limits**, the rules that keep agents from reasoning over
stale state, and **how to communicate with the operator** (see "How to talk to
the operator" below — that rule outranks brevity and speed). If something here is wrong, fix *this file* in the same commit —
don't work around it.

Full context: [`docs/agntic-ops-gap-and-build-plan.md`](docs/agntic-ops-gap-and-build-plan.md).
Commit rules: [`docs/COMMIT_CONVENTION.md`](docs/COMMIT_CONVENTION.md).

## What Atlas is

A conversational workflow builder. The system starts from a vague intent and
closes the gap through dialogue — propose one step, user confirms, measure the
distance to a complete spec, repeat — then emits a JSON spec the existing engine
executes. The hard IP is that **converger** — and it is **built**: a workflow now
also states, in the user's own words, what it promises to deliver, and holds itself
to that promise before it can go live (P12, the "promise system", shipped and in
production). What remains is breadth — more connectors for it to build against (P13).

## How to talk to the operator (READ THIS BEFORE YOU WRITE ANYTHING TO THEM)

**This rule outranks brevity, and it outranks speed. The operator has said
explicitly: if communicating clearly slows production down, that is fine.**

The operator directs this build. They are **not a software engineer**. They know
technology well enough to set direction, judge trade-offs, and call priorities —
and they cannot do any of that if the choice is described in engineer's jargon.
When they are handed a decision they cannot parse, one of two things happens:
they rubber-stamp it, or they spend their attention decoding instead of
deciding. Both are failures, and **both are the writer's fault, not theirs.**

This governs **the main session and every subagent**. Agents write their reports
for the Builder; **the Builder must translate before anything reaches the
operator.** Never paste a verifier or worker report through raw — those are dense
by design and are written for a machine-adjacent reader.

### The rules

1. **Lead with what it means, then how it works — never the reverse.**
   The first sentence says what a person using Atlas would experience. The
   mechanism comes after, and only if it matters to the decision.
   - ✅ *"A workflow that emails customers could go live having been checked
     against nothing — the panel said it was verified when it hadn't tested
     anything."*
   - ❌ *"`contract.every(c => c.ok)` is vacuously true over an empty set."*

2. **Name things by what they DO, not by their identifier in the code.**
   Function names, file names, error codes and validator rules are the codebase's
   filing system, not English.
   - ✅ *"the check that stops a workflow going live when it hasn't been tested"*
   - ❌ *"`UNSATISFIED_ASSERTION`"* / *"`closedDomainOf`"* / *"`_liveLanes`"*
   Mention the identifier only when the operator would need it to find something,
   and put it in parentheses after the plain-language name.

3. **Finding codes and phase labels are internal filing labels. Always restate
   the substance.** "F16", "P12-C", "increment D", "R3" mean nothing on their own
   and the operator should never have to hold that index in their head.
   - ✅ *"the router problem — where a workflow with three paths was approved
     after testing only one of them (filed as F16)"*
   - ❌ *"F16's remaining half"*

4. **Every decision you bring them must have four things**, in this order: what
   is wrong from a user's point of view; what the realistic options are; **what
   you recommend and why**; and what it costs to be wrong. **Never present
   options without a recommendation** — that offloads an engineering judgement
   onto someone who has told you they cannot make it.

5. **Describe what a user would SEE.** "The panel shows a green tick and the Go
   live button unlocks" beats any description of state, flags, or return values.

6. **Numbers need a unit and a comparison.** "0.44 seconds out of a 2.7 second
   test run" is usable; "0.44s" and "76.2%" alone are not. A percentage always
   needs "percent of what".

7. **If a technical term is genuinely unavoidable, define it inline, once, in the
   same sentence.** Do not send them to a glossary mid-decision.
   - ✅ *"mutation testing — deliberately re-breaking the code to confirm a test
     actually catches it"*

8. **Separate what you PROVED from what you BELIEVE, in plain words.** The
   operator has been burned by confident-sounding claims that turned out to be
   noise. Say "I ran this and saw X" or "I have not checked this — it's a
   suspicion based on reading the code." Never blur the two.

9. **Bad news goes first, plainly, without cushioning.** If something is broken,
   was shipped broken, or a previous claim of yours was wrong, that is the
   opening line — not a discovery buried in paragraph four.

10. **Do not narrate process the operator did not ask about.** Which agent ran,
    which file you grepped, and how many rounds it took are not interesting
    unless they change the decision or the cost.

### The words that keep coming up

The operator will keep hearing these because the product is built out of them.
Use these plain-language versions; the code names are in brackets **for other
agents' benefit, not for quoting at the operator**.

- **The promise / the deal** [`outcome contract`] — what the finished workflow
  swears it will do, in the user's own words, plus the machine-checkable version
  of it. It is what "cleared to go live" is measured against.
- **The builder / the interviewer** [`converger`] — the part that talks to a user,
  works out what they actually want, and writes the workflow.
- **A step** [`node`] — one thing a workflow does: read email, summarize, post to
  Slack, ask a person.
- **The blueprint** [`spec`] — the saved definition of a workflow: its steps, its
  trigger, and its promise.
- **A path** [`lane` / `branch case`] — one of the routes a workflow can take
  ("urgent goes to Slack, billing goes to the inbox").
- **The approval step** [`human node`] — where the workflow stops and waits for a
  person to say yes or no.
- **A checkpoint** [`gate`] — the pass/fail check that says a phase is finished.
- **Re-breaking the code on purpose** [`mutation testing`] — changing the code
  back to the broken version to confirm a test actually notices. A test that
  still passes when the bug is back is protecting nothing.
- **Must-fix vs. write-it-down** [`blocker` vs `residual`] — must-fix means a real
  user can hit it and it either looks like success or destroys something.
  Everything else gets recorded and carried, not fixed now.

### The test

Before sending: **could the operator act on this without asking you what a word
means?** If not, rewrite it. If you genuinely cannot make something simple
without making it false, say that out loud — *"the honest version of this is
technical, here it is, and here is the decision it leads to"* — and then give
them the decision in plain language anyway.

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
- **MCP connector runtime** — ⚠️ **NOT IN THIS REPO** (doc corrected 2026-07-14). The
  per-user subprocess-isolation / isolation-tested / manifest-driven runtime
  (`mcp-client.js`, `per-user-mcp-pool.js`, `cross-user-mcp-isolation.test.js`, …)
  exists **only in the read-only `agntic-prod` archive** and was **never migrated**.
  Atlas has just `src/connectors/connector-manifest.js` (an **inert** `mcp` data
  template, marked inert in its own header, consumed only for OAuth provider config)
  and a dead `registerMcpChannel` wrapper (`src/workflows/channel-handlers.js`) gated
  on a `ToolRegistry` class that **does not exist** here; the `mcp_tool` node type was
  deleted in P12-A (`REMOVED_NODE_TYPE`). So "connector #N is a config edit" is **false
  for the native OAuth connectors** (`src/connectors/`, ~4,170 LOC — each needs
  oauth.js + index.js + server.js routes + a `CONNECTOR_INJECTORS` entry). The intended
  MCP path is **new construction**, not salvage: see
  [`docs/architecture/mcp-capability-adapter.md`](docs/architecture/mcp-capability-adapter.md)
  — an adapter that projects remote (Streamable-HTTP) MCP tools **into** the
  `CapabilityRegistry`, deliberately NOT resurrecting the archived stdio pool.
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
- **Event triggers actually fire (2026-07-24)** — three silent failures, all of the same
  shape: a user publishes a trigger, Atlas shows the workflow live, and it never runs.
  Found while scoping the premade-workflow library
  ([`docs/handoff/workflow-library-draft-2026-07-24.md`](docs/handoff/workflow-library-draft-2026-07-24.md)).
  1. **Airtable "record changed" was dead three ways over.** Nothing created the webhook
     (`POST /connectors/airtable/webhooks` was called from nowhere in `src/` **or**
     `public/`); nothing renewed it (`refreshAirtableWebhook` had exactly one reference —
     its own definition — against Airtable's 7-day expiry); and the event names never
     agreed (the converger's generic trigger template emits the capability id
     `airtable_record_changed`, the dispatcher matched only the bare `record_changed`), so
     a correct trigger matched **no** workflow even with a webhook in place. New
     `src/connectors/airtable/webhook-sync.js` is an **idempotent, tenant-scoped
     reconcile**: it makes the live webhook set equal what the tenant's active workflows
     need, in both directions. Called on publish / edit / delete / status-change
     (`builder.js`) and exposed as `POST /connectors/airtable/webhooks/sync`; renewed daily
     from `start()` and once at boot so a restart heals. **Best-effort but never silent** —
     publish returns a `triggerWarning` when the watch could not be armed, because "saved
     but not armed" is the truth and "live" is not. `registerWebhookRoute` now persists
     `tableId` (part of a webhook's identity: base-wide ≠ one table).
  2. **A Slack channel filter written by NAME could never match.** `dispatchSlackEvent`
     compared `"#requests"` against the channel **ID** Slack puts on the event. Now
     resolved via the existing `resolveChannel`, cached per tenant (positives indefinitely,
     misses for 60s so inviting the bot takes effect without a restart). **Unresolved means
     DOES NOT MATCH and is logged** — never "matches everything".
  3. **The `keywords` filter was enforced by nothing** — declared on the `slack_message`
     trigger's `configSchema`, applied nowhere, so the workflow fired on every message
     while its own definition promised otherwise. And **`app_mention` events were dropped**
     (`ev.type !== 'message'`), making the catalog's "Slack App Mention" trigger
     unrunnable.
  Matching logic is now exported and pure (`selectSlackFlows`, `slackEventKind`) so a check
  can construct it the way production does. Pinned by `tests/api/slack-trigger-dispatch.test.js`
  (18) + `tests/api/airtable-webhook-sync.test.js` (20); **every guard hand-mutated red→green**.
  **Not yet witnessed live** — code-level only; a real Slack post and a real Airtable record
  edit are the pending confirmation.
- **Publishing FAILS CLOSED when a trigger cannot be armed (2026-07-24, operator's call —
  this reverses the best-effort behaviour shipped hours earlier in the same session).** A
  workflow that saved, shows as live, and can never fire is the lie the product exists to
  prevent, and the operator judged a warning banner next to a green tick insufficient. The
  cheap, deterministic reasons (no base named; Airtable not connected) are refused **before
  anything is written** (`checkAirtableTriggersArmable` → 422 with a plain-language fix);
  the one that can only be found by asking Airtable rolls the publish back
  (`workflowStore.delete` + a reconcile to prune any orphan webhook) and returns 502
  `TRIGGER_NOT_ARMED`. The PUT path is the publish path for most workflows, so it enforces
  the same rule, marking the workflow `error` rather than leaving it live. **Do not weaken
  this back to a warning.**
- **Trigger frequency is a user setting (2026-07-24)** — `src/workflows/trigger-frequency.js`,
  config key `checkEvery` (minutes) on a trigger. ONE user-facing idea, two mechanics,
  because Atlas's triggers arrive two ways and a single mechanic would be a lie:
  **polled** (email — genuinely hardcoded at every 60s tick until now) sets the *poll
  interval*; **pushed** (Airtable) sets a *floor on how often the workflow may run*, since
  there is no checking to slow down. **An event inside the quiet window is DEFERRED to the
  end of it, never dropped** (`createRunGate`) — dropping would be a fresh silent failure of
  exactly the kind this session fixed. **Slack messages deliberately have NO such control**:
  each message is its own unit of work, so a gap could only drop or unboundedly queue them.
  `checkEveryMinutes` does NOT round to whole minutes on purpose — a pushed trigger honours
  30s exactly, and `pollIntervalMs` raises sub-minute values to the tick floor, so the clamp
  guards a reachable value instead of being decorative (found by mutation: the rounded
  version made the floor unreachable and the mutant survived). Pinned by
  `tests/workflows/trigger-frequency.test.js` (18), mutation-verified.

- **EVERY new connector must state whether it can "phone us" (operator, 2026-07-24).**
  Before the connector is built, answer in its own header comment: does the service
  publish a subscription/webhook mechanism, or must Atlas poll it? If it pushes — who
  registers the subscription **and when** (arming on publish is not automatic), does it
  expire and need renewing, how is an inbound call proved genuine, and how is it torn down
  on delete/pause? If it polls — at what interval and what does that cost across every
  active workflow? And does push require Atlas to be publicly reachable (if so, that
  trigger **cannot be proven on a laptop**, and a green local suite must not stand in for
  the live check)? This is not bookkeeping: it decides what the connector can promise, what
  the user's "how often should this check?" setting means for it, and where it can be
  tested. **Today Slack and Airtable push; Gmail POLLS every 60s** even though Google
  offers Pub/Sub push (never built, `google/index.js` `gmail_new_message` says so in its
  own description); web and filesystem have no trigger at all. Full checklist in
  [`docs/handoff/p13-implementation-brief.md`](docs/handoff/p13-implementation-brief.md).

## Hard-won lessons (do not relearn these)

*Distilled from the P12 build diary — the full per-increment story is archived at
[`docs/history/p12-build-log.md`](docs/history/p12-build-log.md). Every rule below was
paid for in real debugging rounds, and almost every one reached a `main`-candidate state
behind a **fully green test suite** before an independent reviewer caught it. Treat them
as load-bearing.*

**On trusting tests**

- **A green suite is evidence of nothing until you have watched it go red.** When you add
  a guard, re-introduce the bug by hand and confirm a test fails. A guard whose mutation
  survives is pinned by nothing. (This is now a *practice*, not a gate step — the mutation
  tooling was removed; see "Mutation testing was removed".)
- **Assert what was SENT or DELIVERED, not that a step ran.** A test that checks "a delivery
  happened" passes on a broken engine that delivered the *wrong thing*. Put nothing between
  the step under test and the assertion — a laundering node in the fixture masks the bug.
- **A check must construct its subject the way PRODUCTION does.** A test that hands in what
  production omits (or omits what production hands in — no capability catalog, no
  `channelRegistry`, an extra `workflowId`) is testing a program nobody runs. Multiple real
  defects were invisible purely because the check and production were configured differently.
- **A `grep`/`ls` gate proves a symbol EXISTS, not that anything ENFORCES it.** Gates must
  exercise behaviour, not presence.
- **The Builder writes both the code and its tests, so they share blind spots.** The
  independent `verifier` is the remaining defense — it did not write the code and may still
  FAIL a merge. Do not treat your own green suite as the last word.

**On silent failure (the theme of this whole phase)**

- **A silent fallback is not a safety net; it is the bug.** A `?? 'default'` on a
  correctness- or security-relevant value (tenant scope, workflow id, a routed-on value)
  is wrong by construction and fails invisibly — it once handed one tenant's output to
  another tenant. **Fail closed: refuse to run rather than run under a guessed value.**
- **Refusing to certify is always available; certifying without checking is not.** A check
  that silently degrades when it can't see its inputs must *refuse to pass*, never wave
  through. "It ran cleanly" is only honest certification when there was nothing to check.
- **"Not exercised" is a verdict — distinct from pass and from fail.** Certifying the
  *absence* of evidence as success is how the product told users their workflow was verified
  when it had tested nothing (empty assertion set, a router sample that took the do-nothing
  lane, a negative "should not fire" example). Refuse to certify an unexercised promise — but
  do NOT flip it to a false *failure* either, which throws valid specs into expensive rebuild
  loops. Add the missing third answer; never pick the wrong one of the two you had.
- **The mandatory catch-all is a silent-misroute DETECTOR — never let it become a masker.**
  A branch routing on an unchecked or free-prose value matches nothing, the catch-all
  swallows 100% of traffic, and the run reports `run_completed`. Every routed-on value must
  have a **closed, declared domain checked at build time**.

- **A function that switches off the thing keeping a page alive must make its callee
  accountable for what happens next (2026-07-26).** The build page's status check hands a
  ready reply to one handler and cancels its own timer, so any handler branch that returned
  without drawing anything left the page permanently dead — no spinner, no error, nothing to
  click, and a reload reproduced it. Both of that function's safety limits (30-min build cap,
  90-s offline grace) were unreachable: they live inside the closure of the timer that no
  longer existed **and they reset on every call**, so the obvious fix — "just call the poller
  again" — would have destroyed the very backstop it relied on. The rule: the render step must
  RETURN TRUE to claim it left the page actionable, and a caller that re-enters a polling loop
  carries its own budget. Pinned by `tests/api/build-poll-watchdog.test.js` (15), all guards
  hand-mutated red→green.
- **A label that makes a claim about the USER must fail toward the WEAKER claim
  (2026-07-26).** The plan card's marks (`you said` / `I found` / `I inferred`) resolved
  anything unrecognised — missing, empty, `null`, a typo, a value the model invented — to
  **"you said"**, the strongest possible claim about a person. A tester was shown *"Atlas will
  create the #ops channel — YOU SAID"* for a channel they had only NAMED, and the build then
  skipped the work because the plan read as settled. **Two causes compounded:** the renderer's
  fallback was the strongest claim, and the grounding prompt literally instructed the model to
  *"keep confidence 'you said'"* — a value not even in the plan's own declared
  `stated|found|inferred` set, so it could ONLY ever land in that fallback. **A mark that is
  usually right is worse than no mark** — it teaches the user to trust the occasional false
  one. The domain is now closed in one place (`src/converger/plan-provenance.js`) and applied
  **twice on purpose**: server-side in the `plan` node so a client that never ran cannot
  receive an unlabelled item, and in the browser. **And the plan must not settle a question
  another stage asks properly** — a destination that does not exist is the create-or-pick
  conversation's decision, not the plan's to pre-announce. Pinned by
  `tests/converger/plan-provenance.test.js` (20), four mutations red→green.
- **Never let the model describe Atlas's own screens (2026-07-26).** The chat assistant may
  talk freely about the user's work; it may not say where anything lives in Atlas. It invented
  a "workspace settings" screen with a "Connectors / Integrations" section — neither exists
  anywhere in `src/` or `public/` — and sent a non-technical user hunting, immediately after
  giving a genuinely good refusal. **Bar the description; do not supply a better one:** any
  accurate account of the UI goes stale the moment the UI changes and then lies with
  authority. (Proof it drifts: the QA report's own description of that screen was already
  wrong within hours.) There is exactly one place the assistant may name — **Connections, in
  the left sidebar** — and it says nothing about what is inside it. Backed by
  `scrubInventedNavigation` (`src/api/chat-navigation-guard.js`), which rewrites an invented
  instruction before the user reads it; **the prompt rule alone is a belief about model
  behaviour and is pinned by nothing.** Known blind spot, deliberate: an invented instruction
  that never names the product is not caught by the backstop.
- **A person must never be asked to approve a step they have not been shown (2026-07-26).**
  Step approval was a 58px shape, a name clipped to 18 characters and a 19px tick on hover;
  two QA testers approved 11 and 13 steps having been shown no card, no detail, no expansion.
  **That is why a worse defect got through:** a plan listing FOUR paths, built as THREE,
  reported `13 / 13 APPROVED · every step approved` — the branch's mandatory catch-all
  silently absorbed the fourth answer. The step being approved now carries a card with its
  FULL untruncated name, a plain-language sentence, its real configuration, and for a routing
  step **every path it can take**. A value the upstream step can produce that no path names is
  shown in red with the path it would silently take instead, the status line refuses to say
  "every step approved" while one exists, and the card stays after the last tick. The
  derivation is **pure and separate from the renderer on purpose** — the render closure is
  unreachable from outside the render pass, the same trap that let the destination fix revert
  silently. Pinned by `tests/api/step-approval-card.test.js` (28), four mutations red→green;
  `.claude/skills/atlas-product/SKILL.md` §5 extended in the same commit.

**On the control-flow / promise engine**

- **A check scoped to the PRODUCER is wrong; scope it to the VALUE.** Denylists ("its parent
  isn't an LLM") are defeated by one laundering hop through another node. Allowlist the
  shapes that *declare their value set* instead — a value's domain is not bounded by who
  produced it. This is "THE MOAT": a workflow may only branch on a value from a fixed, known
  list (`LLM_INPUT_NOT_ENUM`). **Never weaken it.**
- **Control-node output is never the work product.** `branch` / `human` / `decision` /
  `deliver` outputs must never become `lastOutput` or a transform's input — else the customer
  receives `{"decision":"approve",…}` instead of the reply. This holds on **both** executors
  (top-level and the `foreach` sub-loop). *A new control type is not done until it is in both
  sets* — this exact line has been the defect three times.
- **An approval step ALONE is not a gate — it needs a `branch` reading its decision.** A
  `human` node only *reports* the answer; nothing stops the next step, so `draft → ask → send`
  sends on reject. And an approval must **never** be accepted from a reply email
  (`EMAIL_REPLY_APPROVAL`) — a "From:" is forgeable and a forwarded thread is full of "yes".
  **Never weaken either.**
- **A fix is not verified until the process under test was restarted after the fix landed on
  disk.** The dev server does not auto-reload; a running process can be hours stale. Check
  process start time vs. the edited file's mtime before trusting any result.
- **Never use an unprintable character as a separator.** A NUL (`\0`) or a `\u0001`
  in a lookup key is invisible in an editor and in a diff and silently fails to match — it
  made a whole feature unpublishable, and caused a silent lane-coverage miss. Use
  `JSON.stringify([a, b])`; plain string concatenation can also collide (`"ab"+"c"` == `"a"+"bc"`).
- **A SQLite table rebuild must carry over EVERY column, not just the ones its `CREATE TABLE`
  lists** — later one-off `ALTER`s add columns the DDL never mentions, and copying only the
  intersection silently strips them.

**On working from briefs and docs**

- **Re-ground every remediation brief against live code at the moment you execute it.** Line
  numbers and endpoint names in a brief are non-authoritative provenance; the invariant plus
  a behavioural test is the contract. Believe an executing agent's fresh grounding over a
  brief's *conclusions* — but never over its *measurements*; reconcile contradicting evidence
  before concluding.
- **The doc is the memory — fix a stale doc in the same commit as the code.** A design doc
  that disagrees with `main` is *confidently* wrong and reads as authoritative; the next
  session rehydrates from it and builds on the lie. If the code is right and the doc is wrong,
  that is a doc bug, and it is yours.

- **The product does not narrate its own run results in prose — the sentence is COMPOSED from
  the run's evidence (2026-07-27, operator's call).** After a PASSING test the chat told a
  tester the workflow *"classified it as spam, routed it to the correct path, and then
  summarized and delivered it to both the #ops channel and to charles@agntic.co as promised"* —
  **spam is the branch whose entire promise is to do nothing**, and two inches above, in the
  same screenshot, the evidence panel said it correctly (*"it took a path that doesn't cover…
  Nothing was proved either way."*). This is the SECOND round of one defect: the first
  (2026-07-22, an unverified run described as a failure with an invented cause) was patched at
  the prompt and came back through a different door, because **the boundary stayed lossy in the
  same way**. The client computed `outcomeResults` — one per-example verdict carrying
  `kept | broken | not_exercised` — and dropped it at the POST, sending instead `deliveries`
  from the LAST run of the sequence. A model handed a delivery receipt and told to "be
  specific" fills the gap it was left; **a sterner prompt cannot supply evidence that was never
  sent**. Now `src/workflows/run-summary.js` composes the sentence deterministically from the
  same objects the panel renders, and the endpoint calls it instead of a model. The
  "cannot disagree" property comes from **both surfaces reading the same `verdict` field**, not
  from two hand-written paths that agree today; `contractPassed` is deliberately NOT read (it is
  `true` over a set of skips, by design). The composer **never receives the run's deliveries,
  steps or output**, so it cannot narrate them, and it **fails closed** — a caller claiming
  `passed` over evidence with nothing `kept` in it gets the honest sentence. Scope: prose that
  narrates **what a run did**. The interview, the plan's reasoning and the refusals are
  deliberately NOT in scope — the operator drew that boundary himself. Pinned by
  `tests/api/test-summary-verdict.test.js` (24 — the 2026-07-22 suite re-pointed; its pins now
  assert THE SENTENCE, not merely what the narrator was told), six mutations red→green. **One
  mutation survived the first pass** and the test was strengthened rather than the mutation
  dropped: crediting a "should not fire" example's real delivery as proof was invisible while
  both lanes delivered to the same place.

- **Closing the SET a label may come from does not make the label TRUE — check the claim
  against the evidence, and mark it WORD BY WORD (2026-07-27, operator's call, two parts
  shipped together).** The plan card's marks were closed to `stated|found|inferred` on
  2026-07-26 and that held: the `#ops` case never came back. It also missed the real defect,
  on all three builds QA looked at. *"Runs every morning at 8:00 AM local time"* — **YOU
  SAID**, over a tester who said "every morning" and never named a time. *"non-urgent
  emails… the workflow ends silently"* — **YOU SAID**, never mentioned, sitting beside a
  correctly amber line for equally unstated content. The trigger's *"unread"* and *"Gmail"*
  specifics — **YOU SAID**. Every one of those labels was a well-formed member of the closed
  set. **The set check validates the label's VOCABULARY, not its TRUTH, so the model became
  the laundering hop** — the shape this file warns about four defects deep: *a check scoped to
  WHO PRODUCED the value rather than WHAT THE VALUE CAN BE*.
  **The fix is ONE mechanism doing two jobs**, which is why they could not ship apart: the
  plan line's words are matched against what the customer actually typed
  (`src/converger/said-words.js`), and the match answers both *which spans are theirs*
  (the highlighting) and *whether the claim is supportable at all* (the demotion). A strict
  per-line check ALONE turns most of the card amber and teaches people to ignore it;
  word-level marking is what makes it readable. Applied server-side in the `plan` node so a
  client that never ran cannot receive an unverified strong claim, with the browser refusing
  to mark anything on a plan carrying no spans, or spans that do not reconstruct the line.
  **The corpus was the trap, and it is an ALLOWLIST.** Nothing server-side stored what the
  customer typed — the browser had it and the POST threw it away — so `typedTurns` now rides
  on `POST /api/builder/sessions` into a `humanTurns` state channel. Three near-misses,
  recorded because each looks reasonable: **`intent` is written by a MODEL** (`build_intent`),
  so checking the plan against it is a second laundering hop; **`clarifications[]` is partly
  MACHINE-authored** — the `gaps` node pushes the model's own suggested answers, plus
  `(setup: …)` and `(still missing)` — so it would have Atlas proving a claim against its own
  output; and **`isOperator` is not "typed"** — "Build it", "Skip this setup step." and every
  suggested chip wear the user's avatar and were written by Atlas. Only free prose a person
  composed is admitted, and **an empty corpus certifies NOTHING** rather than everything.
  Fails toward the weaker claim throughout: the check only ever DEMOTES (a `found` line is a
  claim about a tool and is untouched; an `inferred` line is never promoted), a line with no
  content words of its own proves nothing, and **a stopword can never certify** — "the" is in
  every corpus. The legend was reworded, not removed (the operator considered removing the
  marks and the legend and rejected it), and it says something different when the check could
  not run. Pinned by `tests/converger/plan-said-words.test.js` (34, including the REAL
  `POST /api/builder/sessions` driven end to end to the plan card, because "computed and
  dropped at the POST" is exactly how the run-summary defect worked); `plan-gate` and
  `plan-provenance` were **re-pointed to supply the typed turns production now sends**, which
  makes their `stated` assertions stricter, not weaker. **Thirteen mutations, TWO survived the
  first pass and the fixtures were strengthened rather than the mutations dropped:** admitting
  `clarifications` into the corpus changed nothing in a graph-driven test because the plan gate
  fires *before* the elicitation that fills that array, and coercing a non-string turn with
  `String(t)` was invisible until a test asked what `"[object Object]"` certifies. A third
  find: the stopword rule had been written twice and **the second copy was dead** — deleting it
  changed no output and no test noticed — so it was collapsed to one place, the same
  two-copies-of-one-rule shape already on the residual ledger. **Not yet witnessed in a
  browser**; the matcher's segmentation also rests on a BELIEF that the model keeps writing
  plan lines as ordinary prose, which no test can prove.

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

### Self-serve is OFF — Atlas is a product you cannot buy yourself (2026-07-21, operator)

**The decision:** Atlas stays exactly the product it is — no services refactor — but nobody
provisions themselves. Workspaces are created by hand (`POST /admin/tenants`, platform-admin
gated) and plans are **granted**, not bought (`tenantStore.setPlan(id, 'business')` — already
unlimited everywhere, `entitlements/index.js:45`, and already excluded from `SELF_SERVE_PLANS`
because an unlimited plan a card can buy is an unbounded cost liability). This deliberately
**does not** execute
[`docs/handoff/services-pivot-implementation-plan.md`](docs/handoff/services-pivot-implementation-plan.md),
which stays on file as the plan for *if* the services pivot is ever committed to.

**The lever is one env var, and NOTHING was deleted.** Self-serve has exactly one door —
`POST /api/signup/checkout` → Stripe Checkout → the webhook provisions the tenant
(`server.js:2537`, `:2595`) — and every billing path opens with `if (!isBillingConfigured())`,
which is just "is `STRIPE_SECRET_KEY` set" (`billing/stripe.js:47`). **Unset it on the box and
self-serve is off; set it and self-serve is back.** The Stripe module, routes and columns are
KEPT and dormant. Deleting them (increment 4 of the pivot plan) is the one irreversible step and
is exactly what would foreclose going back to product — **do not do it unasked.**

**What the UI change was** (the only code in this decision): the login screen's "Create an
account" entry and the in-app Upgrade entry are now **gated on that same server fact**, so nobody
walks into a door that can only 503. `/setup/status` gained `selfServe: isBillingConfigured()`
(pre-auth, so the login screen can read it); `#signup-entry` is `display:none` in the HTML and
revealed only when that flag is true — **fail-closed, because if the status call fails we cannot
know**, and the `.catch` path no longer opens signup either. A `?plan=<tier>` marketing deep-link
falls through to ordinary sign-in instead of a form that 503s. In-app, `showUpgradeEntry` requires
`billingConfigured` (the usage payload already carried it, `builder.js:793` — it was simply never
read), and with checkout off every non-current plan card degrades to **"Request a consult"**
rather than rendering with no way to act on it.

**Verified in a headed browser, both directions** (the operator's standing rule): with the key
unset the entry is gone and `/?plan=solo` lands on sign-in; restarted **with** the key, "Create an
account" is back. Proving it comes back is the point — it is what distinguishes a gated feature
from a deleted one.

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

- **Text substituted into a `{{…}}` template may never change the STRUCTURE of the value it
  lands in (2026-07-26).** A workflow that had an AI write a summary and then assembled it
  into a document died on **twelve of twelve** runs across two builds with `assemble sections
  is invalid JSON: Bad control character in string literal`. The stored config was valid JSON
  — `[{"heading":"…","content":"{{format_emergency.output}}"}]` — and the build-time probe in
  `node-types/assemble.js` is RIGHT to pass it: the value is not knowable until the workflow
  runs. At run time the placeholder was replaced with what the AI wrote, RAW, so the first
  line break ended the JSON string literal. Passed every build-time check, then failed 100% of
  the time. Fixed at the ONE run-time interpolation site (`FlowTester._substitute`), not
  inside `assemble`, because the same shape reaches every config value parsed as JSON
  downstream — an Airtable `fields` map and Sheets `values` both `JSON.parse` a config string
  and were broken identically. **The escape is CONDITIONAL on where the value lands and must
  stay that way:** almost every interpolation goes into plain text (an AI step's instructions,
  a Slack or email body) and must keep receiving real line breaks — escaping unconditionally
  would put literal `\n` into every message a customer reads, which is worse than the bug
  being fixed. `src/workflows/template-escape.js` decides it by neutralising every `{{…}}` to
  a bare word and parsing: object or array ⇒ structured. That is exact, not a heuristic — a
  bare word is legal JSON only inside a string literal. Requiring object-or-array is
  deliberate: a body of `"{{prev}}"` with the quotes typed by a person parses as a bare JSON
  string, and escaping it would be the over-escaping regression itself. Pinned by
  `tests/workflows/interpolation-escape.test.js` (12); **both halves hand-mutated red→green.**

- **Delivery nodes need context-aware output formatting (unbuilt, P10+).** The
  `deliver` node and connector-action delivery capabilities pass output through as-is,
  with no awareness of the target channel's format requirements. The Airtable
  announcement workflow is the canonical broken example: the LLM emits HTML and the
  email delivery sends it verbatim, so recipients see raw `<p>` and `<br>` tags instead
  of formatted text. Each delivery channel needs its own output transform: email should
  render HTML properly (set Content-Type text/html) or strip tags to plain text; Slack
  should convert to mrkdwn; SMS/webhooks should strip all markup. Fix belongs in each
  capability's `handle` in `src/connectors/*/index.js`, not in the LLM prompt.

- **Email bodies reach a workflow as READABLE TEXT, not raw HTML — the INPUT mirror of the
  gotcha above (fixed 2026-07-16).** `extractBody` in `src/connectors/google/index.js` prefers a
  `text/plain` part, but an HTML-ONLY email (most marketing/notification mail) has none, so it
  used to fall back to the raw `text/html` part — handing the workflow a wall of MJML/CSS. An llm
  `extract`/`summarize` node reads that as "no usable body" and, per the guard clause the converger
  writes into every content node ("if empty/missing → output EXACTLY `ERROR: required data not
  found`"), emits the sentinel — which `outcome-oracle.js` (`CONTENT_ERROR_SENTINEL`) correctly
  flags as `broken → contractPassed:false`. This failed a CORRECTLY-WIRED workflow both in the build
  self-test AND at run time (same parser, `parseMessage`), and the failure was NON-deterministic
  (the model choked on the markup only some runs), so the converger's bounded regenerate loop
  spiralled to its aggregate cap and presented the finished spec with the alarming "I rebuilt this a
  few times and it still isn't settling" — a spurious give-up on a spec that actually works. Fix:
  `extractBody` now runs the HTML fallback through `stripHtml` (strengthened to drop
  `<style>`/`<script>`/`<head>`/comments — incl. `<!--[if mso]>` — WHOLE before removing tags), so
  BOTH production and the self-test receive clean prose. **This is not "make the test lenient" — the
  self-test was surfacing a real production fragility; the fix changes production and test together,
  so the test can never pass on input the real run won't see.** The converger's `verify` node also
  now retries a FAILED sample once (`elicitation-graph.js`) — an llm node can flake a single run even
  on a correct spec; only a CONSISTENT (2×) failure regenerates. Verified headed: the 3-way
  support-triage branch now self-tests **2/2 samples passed** on the first generate, no regeneration.

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

- **A build OFFER with no Build it button was SPECIFIED, not broken — and the envelope retry
  was never involved (2026-07-27).** Five builds by four testers all hit the same thing:
  Atlas's first restatement ended *"Want me to set this up?"* with **no button**, every tester
  escaped by typing the literal phrase **"build it"**, and that produced a *second* restatement
  plus a real button. Redundant, not severe (operator's call) — but the diagnosis matters more
  than the fix, because the obvious suspect was innocent.
  **The retry is healthy and has NEVER FIRED.** `envelopeRetried` in `src/api/builder.js` (landed
  2026-07-21, `3901745`) re-asks the model for the JSON envelope with tools disabled, and its
  result *can* set the flag. Measured at `7858ef9`: `chat.envelope.retry` appears **0** times
  across all four `memory/logs/atlas-events.log*` files, ever; of **263** `chat.reply` events
  exactly **4** carry `parsed:false`, dated 2026-07-04, 2026-07-15 (×2) and 2026-07-16 — **all
  four predate the retry landing**. The whole QA session logged `parsed:true, retried:false` on
  every turn. **Nothing was recovering, because nothing was broken to recover.** CLAUDE.md
  previously documented only the JSON-format reminder for tool turns and never mentioned the
  retry at all; that was the doc gap that let the retry look like the suspect.
  **The cause was the prompt obeying its own instruction.** `buildChatSystem()` carried
  *"gently offer ('Want me to set this up?') **but keep ready_to_build:false**"* — the offer
  sentence as a literal string, paired with an order to withhold the flag. And
  `ready_to_build:true` is the *only* thing the button is gated on (`if (twDone.readyToBuild)`
  in `public/index.html`, a recorded decision — do not add a text parser for "yes"/"go ahead";
  none exists anywhere today). So the product asked a question it gave the user no way to
  answer, and the answer turned out to be a password.
  **Changed:** the prompt now sets `ready_to_build:true` **and** writes a `build_intent` in
  both cases — the user asking, *and* Atlas offering — and forbids an offer while the flag is
  false outright. The flag is described as what puts the button on screen, explicitly **not**
  as consent already given (the user still presses it, then approves every step).
  **Pinned by `tests/api/build-offer-actionable.test.js` (8), four mutations red→green.** Read
  the honest split in that file's header: the behavioural half drives the real
  `POST /api/builder/chat` and pins the **mechanism** (`ready_to_build:true` → SSE `done`
  `readyToBuild:true` with the intent riding along), which **nothing anywhere asserted before**
  — `grep -rn "readyToBuild" tests/` returned nothing at `7858ef9`. The prompt half only pins
  the **instruction**; whether the model complies is a belief no test can prove.
  **Still unproven in both directions:** every tester typed "build it" *specifically*, so
  whether answering "yes please" ever produced a button was never tested. Do not assert either
  way; a headed QA pass is the pending confirmation.

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

- **EVERY live UI verification is done in a VISIBLE browser the operator can watch
  (rule set 2026-07-14, operator).** When driving the real app with Chrome DevTools
  (or claude-in-chrome) to prove a change works, do it in a **headed, foregrounded**
  window — never headless, never a background tab the operator can't see. Narrate
  each step *before* the tool call ("clicking Build it", "filling the base field"),
  and **save each screenshot to disk** (`save_to_disk: true` / a `filePath`) so the
  frame lands in the conversation rather than only in the agent's context. The point
  is that the operator watches the verification happen in real time — "the scripts
  pass" is not the same as a person seeing the button work (the D `Approve`-button
  Content-Type bug proved that), and the operator seeing it is not the same as the
  agent claiming it. If a headed window cannot be opened, say so and stop, rather
  than silently falling back to a check the operator cannot witness.
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
- **THE GATE CANNOT SEND REAL EMAIL (2026-07-27, operator: remove sending from the gate
  rather than guard it).** It could, and it did: `scripts/checks/approval-adversarial.mjs`
  boots the real server and parks two runs on a `human` node whose channels include
  `{type:'email', to:'ops@acme.test'}`, and `deliverAsk` dispatches every declared channel —
  so with a mail credential in the environment that gate step delivers **two real approval
  emails, each carrying a live single-use approval magic link**, still prints
  `APPROVAL-ADVERSARIAL-PASS` and exits 0. `Promise.allSettled` swallows the outcome, so the
  send is silent. It got away with it only because that one invocation happens to omit
  `--env-file` while every other `node` call in `p12.sh` has it — "no gate step sends mail"
  was an accident of a list, not an invariant. (Measured against a local SMTP catcher,
  2026-07-27: 2 messages without the lockout, 0 with it, same env file and port.)
  **The mechanism is `scripts/gates/_no-mail.sh`**, sourced by `scripts/gate.sh` and by
  `p3.sh` / `p12.sh` / `p13.sh` after their `cd`. It exports `RESEND_API_KEY`, `MAIL_FROM`,
  `SMTP_*` and `GMAIL_*` **empty**, which wins: measured on Node v22.22.2, `--env-file` and
  `--env-file-if-exists` do **not** overwrite a variable already in the environment, and an
  empty string counts as present. So every descendant of the gate is covered — including a
  step added later that nobody remembered to guard, and one invoked *without* `--env-file`
  that would otherwise inherit a key exported in the operator's own shell. It then **proves
  it and refuses to run** if `mailerConfigured()` is still true, rather than running and
  hoping. **`ANTHROPIC_API_KEY` is deliberately untouched** — the gate loads `.env` for
  exactly that key (`full-journey.test.js` self-skips the converger test without it; that is
  how P11 was nearly closed on a false pass) and the lockout must stay targeted at mail.
  Pinned by `tests/gates/gate-cannot-send-mail.test.js` (5), run first in `p12.sh` and
  `p13.sh`, hand-mutated red→green. **No product code guards sending** — `mailer.js` gained
  only a corrected doc comment. **Accepted consequence:** the gate no longer exercises the
  email approval channel at all. That is *not exercised*, not *passing* — sending is known
  to work from the operator's own use, which is not a measured result.

## Open residuals carried forward

*Recorded, not forgotten. These are known, non-blocking gaps — a real user can't hit them
in a way that looks like success or destroys something, so they were carried rather than
fixed on the spot. Fold the relevant ones into whatever increment next touches that surface.
(The full P12-era ledger, including everything since closed, is in
[`docs/history/p12-build-log.md`](docs/history/p12-build-log.md).)*

- **Silent blank columns from unchecked sub-field templates** — `{{item.field}}` inside a
  `foreach`, and `{{connectorRead.field}}` off a connector read, publish, write the column
  blank, and say nothing. The source declares no OUTPUT schema, so the field name is
  unknowable at build time. **Closing this needs output schemas on the capability catalog —
  which is directly P13's territory** (see P13-0 groundwork). The natural place to fix it.
- **`tests/e2e/onboarding.test.js` has ~5 failing tests at baseline** (workspace
  provisioning, slug dedupe, team invites, seat limits) — pre-existing, unrelated to P12,
  in no gate's list, and flaky (one run showed 6). A broken window in the E2E suite that
  someone should own.
- **The decision-table rule grammar lives in two functions** in `decision-analysis.js`
  (`coveredAtoms` for the coverage proof, `matchesCondition` for the engine). They have
  disagreed twice; both are fixed, but every future divergence is a proof about a program
  nobody runs. **Collapse them into one when anything next touches the analyser.**
- **`quorum` appears in `converger-v2.md` §7.1 but does not exist** — a `human` node with
  `quorum: 2` is correctly rejected at publish (`UNKNOWN_CONFIG_KEY`), so the defect is in
  the **doc**: anyone building from §7.1 verbatim writes a spec that won't save. Today the
  first valid approval answer wins. Either build quorum or cut it from the doc.
- **A Slack approval message is never updated on timeout** — after the sweeper resolves an
  unanswered pause, the Block Kit message still sits in-channel with live-looking buttons
  (clicking is correctly refused). The honest thing is to edit the message; needs the
  `chat.update` ts that `postSlack` already returns and nothing stores.
- **The `decision_review` UI can edit cells / outputs / hit policy but cannot ADD or DELETE a
  rule** — deliberate for now; a user who spots a rule that shouldn't exist has to say so in
  chat.
- **A duplicate answer can overwrite the question Atlas was about to ask.** Submitting the
  same answer twice makes the second (no-op) result replace the first one's real next question
  in the build record (`src/api/builder.js:257`, `startBuildJob`'s success handler). The client
  no longer freezes on it (2026-07-26), so this is now recoverable rather than fatal — but the
  real question is still lost. Fix is two parts: don't let a no-op overwrite a recorded ready
  value, and guard the composer against a second Return while an answer is in flight
  (`submitInput`'s `if (S.thinking) return` is defeated by `setState` being asynchronous).
- **`POST /api/builder/chat` decides "the client hung up" on a one-tick race.**
  `express.json()` consumes the request body and Node then fires `close` on the request while
  the socket is still open; the handler treats that as a disconnect and suppresses the whole
  SSE stream. **It works today only because `requireAuth` is `async`**, so the handler attaches
  its listener after the spurious event goes by. Make auth synchronous, memoise the session
  lookup, or add a fast path, and chat returns HTTP 200 with an empty body and no error.
  Proved on Node 22 + Express 5 (the deployed pairing) 2026-07-26; not reachable today. Fix:
  treat the request as closed only when the socket is actually destroyed.
- **The second step-approval mechanism in `public/index.html` is DEAD** —
  `_approveCurrentStep` / `_approveAllSteps` / `_graphOrder` / `graphCanvas` and their state
  are reachable only from each other; the `graphCanvas` view-model is recomputed on **every
  render** and no template binds it (`grep -n "{{ *graphCanvas" public/index.html` returns
  nothing). ~120 lines. Deleting it needs old saved slices (which still persist
  `graphApproved` / `graphSelNode`) to keep loading cleanly.
- **The plan's grounding speaks about a Slack workspace the tenant may not have connected.**
  The create-or-pick question requires `connectors.slack.connected` (`gap-scorer.js:286,296`);
  the plan's grounding checks only that a channel list loaded
  (`elicitation-graph.js:1700`), and `builder.js:1585-1596` can populate that list from
  `SLACK_BOT_TOKEN` without the per-tenant guard. So Atlas can promise a confirmation nobody
  ever asks for. Made benign for the "you said" invariant 2026-07-26, not closed.
- **Two copies of the "what counts as a template reference" rule** — the build-time probe
  (`node-types/assemble.js`) and the run-time escaper (`template-escape.js`) each carry their
  own `\{\{[^}]+\}\}`. They agree today because the second was written to match. This repo
  has already paid twice for this shape on the decision-table grammar. Collapse them when
  anything next touches either.
- **The diagram's type tag is still jargon** — `CONNECTOR-ACTION` / `LLM · SUMMARIZE`
  (`_nodeShape`) sit beside the approval card that now says the same thing in English.
  `_nodeShape` reaches five surfaces including the exported procedure document, so changing
  it outright is wider than it looks.
- **Approval-channel availability (`email`) is deployment-wide, not per-tenant** — fine today
  (one deployment, one mailer); revisit if tenants ever bring their own sending domain.

## Agents & gate enforcement

**Builder is this main session** (you), governed by this file — not a subagent.

**One subagent lives in `.claude/agents/`:**

- **`verifier`** — fresh, independent gate checker; did *not* write the code. It
  is invoked by `/gate <phase>`, it may still FAIL a merge, and since the mutation
  apparatus was removed it is **the only independent check on the Builder's own
  work**. Do not retire it without replacing what it does.

**Retired, and deliberately (2026-07-25, operator's call):**

- **`scout`** — read-only explorer. Retired as **redundant**: Claude Code now ships
  a built-in `Explore` agent that does the same fan-out search, and nothing here
  invoked `scout` — its only mentions were descriptions of itself. Use `Explore`.
  If you miss its evidence discipline (conclusions with `file:line`, never edits),
  say so in the dispatch prompt.
- **`adversary`** — Phase 3 converger stress-tester. Retired because **its problem
  stopped recurring**: it was scoped "Phase 3 only" and P3 closed long ago. Nothing
  invoked it. If the converger needs attacking again, that is a fresh hire against
  the checklist, not a resurrection.
- **`test-adversary`** — removed 2026-07-19; see "Mutation testing was removed".

Definitions are kept, not deleted, at `~/Desktop/agent-org/provenance/`. A roster
that shows only the present cannot explain how it got its shape.

**The four below are positions in the agent org**, not local one-offs, and they do
not live in this repository — see "The agent org" at the end of this section
before you dispatch one.

- **`qa-manager`** *(added 2026-07-22; split into manager + worker 2026-07-24)* —
  owns product quality. It **no longer does the testing itself**: it decomposes a
  testing objective into scoped customer journeys, dispatches `qa-worker`s (max 4)
  that drive the real app in headed browsers, and compiles what they observed into
  one prioritised findings report with a demo agenda. It **never edits `src/`**,
  never commits and never deploys.
  **Why it exists:** every serious defect this codebase has shipped was found by
  *using* the product, not reading it, with the suite green throughout — and since
  the mutation apparatus was removed (below), the blind spot where the Builder writes
  both the code and its own tests is uncovered.
  This does not close that hole (it is not a test-designer) but it attacks the same
  blind spot from the only other side available: a person, in a browser, asking
  whether the thing actually worked. It is also the standing answer to the operator's
  rule that a live UI check must be witnessed, not claimed. Splitting it lifted a run
  from one journey per session to several in parallel, and put a reader on all of
  them who can see what no single worker can.
- **`qa-worker`** — carries **one** customer journey end to end in a headed browser
  and writes one report. Read-only, same prohibitions as its manager. Carries the
  headed-browser procedure that used to live in the QA Manager.
- **`coding-manager`** *(added 2026-07-24)* — owns implementation. Takes findings
  (from QA or from the operator), re-grounds them against live code, sections them
  into packets that cannot collide, dispatches `coding-worker`s (max 3), and verifies
  the packets integrate. **It does not write the code**, does not merge to `main`,
  and does not deploy.
- **`coding-worker`** — implements **one** packet, pins it with a test, **watches
  that test go red** by hand-reintroducing the bug, and produces a diff. Does not
  commit, merge, or deploy; leaves integration to its manager.

**Pair the QA pair with the `atlas-product` skill** (`.claude/skills/atlas-product/`),
which is the *behavioural* contract — what a person must SEE on each screen — and is
the thing to fix when the product's intended behaviour changes.
**Keep the skill true in the same commit as any behaviour change** — it is read as
authoritative, so a stale one sends a QA worker hunting a bug that was fixed, or
passing one that was introduced.

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

### The agent org

`qa-manager`, `qa-worker`, `coding-manager` and `coding-worker` **do not live in
this repository, on purpose.** They are defined in `~/Desktop/agent-org/` and
installed to `~/.claude/agents/`, outside every repo — so they are dispatchable
from any session and no git operation can remove them. They are tools that
operate *on* Atlas; they are not part of it.

```bash
cd ~/Desktop/agent-org && node scripts/sync-agents.mjs --check   # verify deployed
node scripts/sync-agents.mjs --write                             # install/update
```

**Why they were moved out (2026-07-24).** They were installed here, inside
`.claude/agents/`, which is inside git. A branch cleanup dropped the commit that
added them and **silently deleted two positions and reverted a third** — the org
was un-installed by a routine git operation and nothing announced it. The first
real run then opened by discovering the workers did not exist. `git clean -xdf`
would do the same to an ignored copy, so ignoring them here was not enough; they
had to leave.

**Never put a copy back in `.claude/agents/`.** A project-scoped file **shadows**
the user-scoped one, so a stale copy silently reinstates an old definition
instead of failing loudly — the same failure with a longer fuse. That is not
hypothetical: this repo carried the **pre-split `qa-manager`** — the version that
did the testing itself and knew nothing about workers or the report contract —
for several days after the split, and an Atlas session dispatching `qa-manager`
would have got that one. `.gitignore` blocks the obvious paths, and
`sync-agents.mjs --check` reports any that reappear.

`verifier` is **not** part of that org. It is Atlas's own gate machinery, it
predates the report contract, and it stays here. (`scout` and `adversary` were
listed here too until they were retired on 2026-07-25 — see the roster above.)

Two rules of that org that change how you read what they hand back:

- **Every worker writes one report to a shared contract**
  (`~/Desktop/agent-org/agents/REPORT_CONTRACT.md`), and a manager compiles them into
  `COMPILED.md` + a self-contained `COMPILED.html` under `~/Desktop/agent-org/runs/`.
  **No report = failed run** — a worker's verbal summary with no file on disk is not
  a result, and a manager must not compile a run whose reports fail
  `scripts/validate-reports.mjs`.
- **Workers never read each other's reports.** Cross-worker synthesis is the
  manager's job; the isolation is the point.

Operating manual: `~/Desktop/agent-org/OPERATING.md`.

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
- *(The `mutation-sweep` clause here is void — the sweep was removed 2026-07-19.
  The verifier's targeted hand-mutation of the increment's NEW guards is retained
  and is now the only mutation step that runs at all. It stays because it is
  cheap, it is the one thing a log cannot fake, and it is where the findings come
  from.)*

**3. Only the `verifier` runs after a build.** *(Amended 2026-07-19 — the
`test-adversary` was removed; see "Mutation testing was removed" below.)* Spawn it
after the build; it is read-only with respect to `src/` and may still FAIL the
merge.
- If the Builder then fixes something in `src/`, the verifier gets **the fix diff
  as a delta message** — it does not restart. (`SendMessage` resumes it with its
  context intact.)
- The Builder **fixes**; the verifier never touches `src/`.

**What did NOT change, and must not:** the verifier is fresh, independent, and did
not write the code; it may still FAIL the merge; and a gate still closes only
through its check. Velocity is bought by removing *duplication*, never by removing
*the second pair of eyes*.

## Mutation testing was removed (2026-07-19, operator's explicit direction)

**Removed:** `scripts/checks/mutation-sweep.mjs`, `scripts/checks/mutation-guard.mjs`,
the `test-adversary` agent (`.claude/agents/test-adversary.md`), and the two gate
steps in `scripts/gates/p12.sh` that ran them. **Recorded loudly and deliberately**
— this file states that a diff against `scripts/` is how a verifier detects a
builder quietly weakening their own gate, so a removal must never be silent. This
was the operator's call, not the Builder's, and the Builder must not re-introduce
it unasked.

**Why.** Both scripts rewrite files under `src/` **in place**. That makes them
unrunnable alongside any other work, and the failure is not theoretical: a sweep
left a live mutant in the working tree (`if (allowed === false)` → `if (true)`,
which disables the monthly run cap for every scheduled run), and it produced a
false "resume is broken" finding that was one step from being reported as fact.
Add ~10-minute runtimes and a mandated agent round-trip per increment, and the
apparatus cost more than it returned. Its 78% floor was also, at the time of
removal, the **only** thing failing the P12 gate.

**What was KEPT, and why it is not a compromise.** Every `*-adversarial.test.js`
suite the apparatus produced stays in the tree and in the gate — ~70 tests that
run in **0.44s** inside a 2.67s suite. They pin real defects that reached `main`
behind a green suite. Measured: the tests were never the cost; the machinery was.
**Do not delete them to "finish the cleanup" — that trades protection for nothing.**

**What this costs, stated honestly.** The structural blind spot named in the
"Hard-won lessons" above — *the Builder writes both the code and the tests, so they
share blind spots* — is now **uncovered**. The independent `verifier` is the
remaining defence, and it is not
a full substitute. The discipline survives as a **practice, not a gate step**:

> **When you add a guard, re-introduce the bug by hand and watch the test go red.**
> A green suite is evidence of nothing until you have watched it go red.

This is not a licence to skip it. It is the same rule with the enforcement removed,
which means it now depends on the person doing it.

## Where things stand, and what's next

*(Written for the operator. Plain language first; the technical anchors an agent
needs are in the indented notes. `git log --grep "^Gate:"` is the authoritative
record of which phases are formally finished.)*

**Atlas is live and in use** at https://atlas.agntic.co. People can build a
workflow by talking to it, test it, publish it, and watch it run on a schedule.
Thirteen phases of work got it there; the first eleven are finished and signed
off.

**P12 is closed.** It was closed on 2026-07-20 by operator decision, on the
grounds that the work has been finished, shipped and in real use for weeks. It was
**not** closed by a passing checkpoint and **not** reviewed by an independent
verifier, and the record says so plainly
([`docs/gates/p12.md`](docs/gates/p12.md)) rather than implying a check that did
not happen. The closing commit carries **no `Gate: P12` trailer**, so
`git log --grep "^Gate:"` does not list it — that absence is correct.

**Next up is P13**, once the product's behaviour and appearance have been
hardened (below).

**What is being worked on right now: product hardening, driven by QA.**
Since 2026-07-22 there is a dedicated QA role (the `qa-manager` agent + the
`atlas-product` skill) whose whole job is to *use* the live product like a customer,
in a visible browser, and report what misbehaves — because every serious defect this
codebase has shipped was found by using the product, not by reading it, with the test
suite green throughout. It never edits code.

**As of 2026-07-24 it is a manager + workers**, not one agent: `qa-manager` picks the
journeys and compiles, `qa-worker`s carry one journey each end to end in parallel.
The sessions below predate the split, so they are the record of *one* agent doing
both — the findings stand, the shape does not. Running record:

- [`docs/handoff/ui-test-findings-2026-07-19.md`](docs/handoff/ui-test-findings-2026-07-19.md)
  — the original six-workflow sweep. Theme of the serious ones: **the product told
  people their workflow had been checked when it had not been.** Most now fixed.
- [`docs/handoff/hardening-2026-07-21.md`](docs/handoff/hardening-2026-07-21.md) and
  [`docs/handoff/hardening-2026-07-22.md`](docs/handoff/hardening-2026-07-22.md) — later
  browser sessions; ~a dozen more fixes landed.
- [`docs/handoff/qa-findings-2026-07-22.md`](docs/handoff/qa-findings-2026-07-22.md) —
  the QA Manager's first shakedown: nine findings, all marked fix-now, most closed
  (four of them turned out to be one defect).

*Deploy state drifts during hardening — fixes land on `main` faster than they ship, so
the deployed version trails local. Confirm the real gap with `curl -s
https://atlas.agntic.co/health` against `package.json` before assuming what's live.*

**The test panel sent real messages and could never verify an approval workflow — FIXED
(2026-07-24, operator drove it live).** The operator pressed Run test on a built approval
workflow and got **5 real Slack DMs** and a **"0 real examples · not verified"** verdict
despite the workflow having 8 good examples. Two defects, both in `public/index.html`'s
test panel:
- **A test sent real messages.** The panel ran with REAL deliveries (no `dryRunDeliveries`),
  so testing an approval workflow fired a real Slack DM per urgent example. **Fix:** the
  panel now passes `dryRunDeliveries:true` on every run AND on the resume — terminal sends
  become would-deliver receipts the oracle reads as would-satisfy, so the contract is still
  checked ("would keep its promise") with **nothing actually sent**. The engine still pauses
  at the gate, so the in-panel Approve/Reject still work.
- **An approval workflow could never reach a verdict.** The loop **blanked all accumulated
  evidence at the first pause** (`outcomeResults: []`) and, on approve, scored against an
  empty set (`_answerPause` read a single `outcomeCheck` where the panel expected the
  `outcomeResults` array) — so it always read "0 examples / not verified", however well
  built. **Fix:** completed examples' verdicts accumulate as `pendingEvidence` and are kept
  across the gate; every answerable pause is **queued**; as each is answered its resumed
  verdict **folds into** the evidence; only when the queue is empty is the FULL set scored
  (with lane coverage). Go live stays locked until then. The operator's guess — "behaviour
  after the approve button, built but never verified" — was exactly right. Pinned by
  `tests/api/test-panel-paused.test.js` (updated to the queue mechanism) +
  `test-panel-certification.test.js`; the client script syntax-checks clean.
  **NOT yet witnessed live end-to-end** — the fix is code-level; a fresh Run test through to
  a verdict is the pending confirmation.

**Settled by the QA pass (2026-07-23):**

- **"Editing a workflow silently drops its promise" — DISPROVEN.** The QA Manager drove it
  live: an edit correctly *revokes* the green tick, re-locks Go live, forces a fresh test,
  and the promise survives intact (confirmed unchanged in the DB after the edit through the
  exact PUT path the old F12 bug lived in). Not a defect. This was open item #3; closed.
- **A DISTINCT, worse bug was found and fixed: the self-test corrupted the workflow to defeat
  "ignore spam."** On the canonical classify→approve shape, the converger's self-test (`verify`)
  enforced a conditional promise gated on the *approval branch* even against a **spam** sample
  that never reached that branch — so a correctly-stopped spam email read as a **broken
  delivery**, drove the rebuild loop, and the model rewrote the classifier to forward spam so
  the delivery would fire (~23 min, a workflow doing the opposite of what the user asked).
  **Root cause + fix live in the single shared oracle** (`outcome-oracle.js`): `runRouteInfo`
  now records whether each branch was *reached*; `assertionApplicability` enforces-on-doubt only
  for a branch that actually **ran** — a never-reached gate's promise does not apply (SKIP, not
  enforce). One fix covers **both** the converger self-test and the client test panel. Pinned by
  `tests/workflows/approval-gate-not-reached.test.js` (mutation-verified red→green; the two
  anti-false-pass cases — a real miss on the *reached* lane still fails, a reject still skips —
  are in the same suite). **Status: code-proven (919 tests green, server restarted on the new
  code); a clean end-to-end LIVE witness is still pending** — the first live re-build got stuck
  in the *separate* gap-loop below before it reached verify.

**Fixed by the coding run of 2026-07-26** (agent-org `run-1346-coding`, five packets,
integrated and suite-green at `bef1f9b`, **not merged to `main` and not deployed**). All five
are **code-proven only — none has been witnessed in a browser**, and a headed QA pass is the
pending confirmation for every one:

- **A workflow no longer dies whenever the AI writes more than one line.** The
  summarise-then-post / digest shape failed 100% of the time; the same flaw also broke writing
  an AI answer into an Airtable column or a Sheets row. See *Known gotchas*.
- **The build page can no longer go silently dead.** See *Hard-won lessons → On silent
  failure*.
- **The plan no longer claims "you said" about things nobody said.**
- **A step is shown before you are asked to approve it**, and an answer with no path is
  called out instead of being absorbed by the catch-all.
- **The chat no longer invents Atlas's own screens.**

**Still open, roughly in the order they matter:**

1. **The user's answer does not take effect — RE-OPENED 2026-07-26.** *(Previously
   recorded as closed. It was HALF closed, and the record said "closed". This entry exists
   because trusting that record would cost a whole round.)*
   The original defect had two halves: Atlas **asked the same set-up questions twice**, and
   **the answer did not stick**. `docs/handoff/qa-findings-2026-07-22.md` marked it
   *"Closed with 3 — re-measured: 0 re-asks, 1 build pass"*, which measured the FIRST half
   only.
   - **Half genuinely fixed:** the re-asking. Three independent QA workers on 2026-07-26
     were each asked once and never twice. That half stands.
   - **Half NOT fixed, and it is the half that matters:** the answer still does not change
     what gets built. A tester gave the destination `#support` **twice** — typed once, then
     clicked it — and the finished workflow was built to post to `#ops`. So the user is now
     asked once, politely, and ignored once, silently. From
     the QA run `~/Desktop/agent-org/runs/2026-07-26/run-1224-qa/COMPILED.md`, finding 6, via
     `qa-worker-01`.
   **Not diagnosed yet** — nobody has traced where the answer is dropped between the
   clarification being answered and the spec being written. That is the next piece of work
   on this, and it is scoped but not started.
2. **The blocking-gap rebuild loop — FIXED (2026-07-24), two ways.** *(a) the specific cause and
   (b) the operator's call to remove the wall entirely.*
   **(b) The "Use your suggestions" wall is gone (operator, 2026-07-24).** The converger's gap step
   no longer STOPS the build to make the user rubber-stamp a suggestion — whose default answer was
   already "the suggestions", so it was pure friction, and whose click routed the answer through a
   whole-spec regenerate that (for a reproduced blank) re-asked forever. Reasoning: the product's own
   promise is *publish having answered nothing*, so a blocking gap's suggested answer is the DEFAULT,
   not a decision to ratify. Now: the converger's own blanks auto-repair silently (see (a)); a
   genuinely un-defaultable choice (a destination that doesn't exist) is still asked **conversationally
   and applied DIRECTLY** — create-or-pick, no rebuild (this is the intended "chatbot clarification":
   one natural question, answer applied on the spot); and a wiring gap only a rebuild can fix
   regenerates **silently and bounded**, narrating progress. The user reviews the finished workflow
   step by step, and `complete ⇒ publishable` still gates go-live. `elicitation-graph.js` gaps node.
   Two tests that pinned the *wall itself* were repurposed to pin the new contract (no wall; the
   suggestion still drives a bounded rebuild, not discarded; the connector isn't re-asked) — checks
   preserved, not weakened. ~1,000 converger/workflow/approvals/api tests green.
   **(a) The specific cause (below).**
   Distinct from the verify-spiral. A live re-build (2026-07-23) ran **three** whole-workflow
   generate passes (200s + 90s + **403s** ≈ 11½ min) driven by `blocker_to_chat`, never reaching
   verify. **Root cause (diagnosed from the log):** a document step that assembles from **two+**
   sources (`assemble`, e.g. "compose the approved record" from the extract AND the summary) left
   its `sections` blank; that BLOCKING gap (`DIGEST_MISSING_SECTIONS`) had **no auto-repair for the
   multi-source case** (`_attachSectionFixes` was deliberately narrow to one source), so it asked
   the user — and the answer routed through a whole-spec **regenerate that reproduced the same
   blank**, re-asking forever. **Fix:** `_attachSectionFixes` now fills a **complete default** for
   any document with ≥1 content source — one section per source, in edge order, each headed by its
   own step — applied silently by the existing structural auto-repair (no question, no regenerate),
   exactly as it already does for a missing name or route edge. **It looks THROUGH control nodes**
   (the ACTUAL live shape, found on the re-verify build: "compose the approved record" hangs off the
   approval branch, so it has ZERO *direct* content parents — the first cut of this fix still gave up
   there and looped; the walk now passes through a branch/human to the summary that feeds them). It can never drop content (every
   source appears) and the user edits it like a rename. Zero sources stays a genuine gap. Pinned by
   `tests/converger/section-autorepair.test.js` (mutation-verified; the old narrow guard turns the
   two-source test red). **Carried, NOT fixed:** the *general* pattern — a blocking-gap answer
   always routes through a full regenerate rather than being applied directly — still stands for
   any OTHER gap type whose regenerate can reproduce the same blank. The `set_config`/`applyProposal`
   machinery to apply an answer directly exists; extending it beyond the section case is the
   follow-up (see `hardening-2026-07-22.md`). *(Also: one generate hit 403s — worth checking it
   isn't silently truncating.)*
3. **Test examples can't reach some workflows.** If a workflow starts by fetching something (say,
   "read my unread email"), the made-up test cases can't influence what it fetches — so every
   test case runs against the same live data and proves the same one thing. Filed as F3.
   **Overlaps P13's output-schema groundwork.**
4. **Test runs are counted in the live health dashboard**, so a workflow that has never actually
   fired can show "100% success". Cosmetic, but it is the number an operator trusts. Filed as F14.
5. The rest of the handoff documents — smaller, individually recorded there.

## The phases

- [x] **P0** — the skeleton: the engine starts up in the new codebase and the
      screen can reach it.
- [x] **P1** — Slack: pressing "run" actually posts a message.
- [x] **P2** — workflows that fire on a real event (an email arriving), not just
      on a button.
      - *Hand-authored UPS→Slack spec frozen here as the test fixture.*
- [x] **P3** — the interviewer works: describe a workflow in conversation and it
      builds the same thing a person would have built by hand.
- [x] **P4** — the building screen: a workflow made entirely by talking.
- [x] **P5** — the management screen: see your workflows, watch runs happen, and
      export a written procedure document (PDF and Markdown).
- [~] **P6** — *dropped 2026-06-20.* A floating launcher was planned; the sidebar
      already does the job. Not built, on purpose.
- [x] **P7** — writing to other systems (Airtable, Google), handling failures,
      and running more often than daily.
- [x] **P8** — web research, and reading files from approved folders.
- [x] **P9** — value tracking: time saved per run, and a report a customer can be
      shown.
- [x] **P10** — the admin view: what each customer is using, and what it costs.
      - *Merged `601760c`, `Gate: P10`, ledger `docs/gates/p10.md`.*
- [x] **P11** — end-to-end testing, production hardening, and the move onto a
      real server. **Finished 2026-07-13.**
      - *`b711b44`, `Gate: P11`, ledger `docs/gates/p11.md`. If you re-run this
        gate: the end-to-end suite SKIPS its interviewer test when
        `ANTHROPIC_API_KEY` is unset and still reports "6 pass / 1 skip" — and the
        skipped one is the first thing the gate is meant to prove. Run it with a
        key (7/7) or you are passing a gate you have not tested.*

- [x] **P12 — the promise system.** *Closed 2026-07-20 by operator decision —
  NOT by a passing checkpoint, and NOT independently reviewed.*

  This is the phase that made a workflow **state what it will deliver** and then
  hold itself to that. It added: a written promise attached to every workflow;
  the ability for a workflow to make decisions and take different paths; a step
  where it stops and asks a person for approval before doing something serious;
  and a test panel that runs real examples and reports whether the promise held.

  All seven pieces (A–G) are built, merged, and have been serving real users in
  production since 2026-07-14 (v1.6.0).

  **How it closed, stated honestly.** The operator closed it because the work was
  long finished and the team had moved on to hardening the product ahead of P13.
  The checkpoint script was not run to completion and no fresh verifier reviewed
  the phase. The closing commit therefore carries **no `Gate: P12` trailer**, so
  nothing in the history claims a check that did not happen. Full record:
  [`docs/gates/p12.md`](docs/gates/p12.md).

  **What that leaves unproven** — recorded so nobody mistakes silence for
  assurance: where `bash scripts/gate.sh 12` stops today is *unknown* (its old
  failure, a coverage floor, vanished with the tooling removed on 2026-07-19);
  no whole-phase review was done, and every per-increment review that *was* done
  found real blocking defects; and the open defects in
  [`docs/handoff/ui-test-findings-2026-07-19.md`](docs/handoff/ui-test-findings-2026-07-19.md)
  are still being worked through.

  - *Build spec: [`docs/architecture/converger-v2.md`](docs/architecture/converger-v2.md);
    theory: [`bpmn-dmn-foundations.md`](docs/architecture/bpmn-dmn-foundations.md).
    The gate is progressive — it walks increments A–G and stops at the first
    unbuilt one, so it still answers "what is next?" if anyone re-runs it.
    Increments never carried a `Gate:` trailer; only a phase close does, and this
    one deliberately does not either.*

  **Two rules in here must never be weakened.** Both look like technicalities and
  are not:
  - **A workflow may only branch on a value from a fixed, known list**
    (`LLM_INPUT_NOT_ENUM`). If the AI can answer a routing question in free prose,
    nothing can prove the workflow handles every case — and the whole promise
    system rests on being able to prove that.
  - **An approval must never be accepted from a reply email**
    (`EMAIL_REPLY_APPROVAL`). Anyone can forge a "From" address, and a forwarded
    thread is full of the word "yes". Approvals go through a signed, single-use
    link.

- [ ] **P13 — many more connectors.** *Planned, not started. **Rescoped 2026-07-24** — see
      the box below; the shape of this phase changed.*

  Today each new service Atlas can talk to is hand-built, which is why there are
  only a handful. This phase makes Atlas able to connect to a service **that nobody
  hand-built, with no developer setup by anyone** — the customer clicks one button,
  approves on the service's own screen, and it works. Triggers ("when this happens…")
  stay hand-built and are **not** in this phase.

  **The constraint that set the scope (operator, 2026-07-24).** Atlas is a no-code
  product for non-technical people, so **a customer must never be sent into a developer
  settings screen** to create an integration, pick permissions, and paste a secret. That
  leaves exactly two ways to connect a service, both ending at one Connect button:
  1. **Self-identifying — no setup by anyone.** Atlas publishes one identity file at a
     fixed address it already owns (`atlas.agntic.co`), and that address is its identity
     with every service that supports the standard. *(Client ID Metadata Documents —
     CIMD / SEP-991, MCP authorization spec 2025-11-25. It supersedes the older
     register-us mechanism, DCR/RFC 7591, which was downgraded `SHOULD`→`MAY` **because
     CIMD replaced it**.)* **Verified 2026-07-24:** Notion, Linear, Stripe, Asana,
     Sentry, Figma. **Blocked:** Atlassian (approved clients only) and Google (rejects it).
  2. **Agntic registers once** — a developer account, an app, permissions, a callback and
     two secrets on the box, once per service forever.

  **P13 ships route 1 only.** Consequences, recorded honestly because they are a real
  cost and a deliberate trade, not an oversight:
  - **Generating connectors from a published API manual (OpenAPI) LEFT the phase.** Such
    a connector always needs someone to register an app — it is always route 2. It stays
    in the design doc as the on-demand mechanism for route-2 connectors *after* P13.
  - **Microsoft 365, HubSpot and QuickBooks are OUT of P13** — all route 2, and arguably
    the highest-value services for the client base. They are the first afternoons after
    the phase closes.
  - **The connector setup screen is OUT of P13** — it exists to make route 2 cheap and has
    nothing to serve in a route-1-only phase. Build it alongside the Microsoft 365 work.
  - **The MCP adapter moved from last-and-optional to the phase's entire delivery
    mechanism.**

  **The hard stop that must not be softened.** The standard's identity order is
  *pre-registered credentials → CIMD → the older register-us mechanism → **prompt the user
  to type in credentials***. **Implement the first three and STOP.** That fourth step *is*
  the banned developer-settings screen, and a naive implementation of the spec falls
  through to it by default. A service that exhausts the first three is **"not supported
  yet"** → it goes on the route-2 list. It never degrades into asking a customer for a token.

  **Start with the groundwork, not the connectors.** **Four** things in the existing
  code assume the connectors we happen to have; if new ones are added first, every
  one of them inherits the same silent bug (Atlas mistaking which steps write data,
  which is how a workflow ends up not doing the thing it promised). The fourth was
  added 2026-07-24: **which credential a step receives is decided by hand-typed lists
  of action names in `server.js`** (`CONNECTOR_INJECTORS` + the per-connector
  `*_ACTION_IDS` Sets). The code carries its own warning that a capability missing from
  its list gets no credential at run time *even though the customer is correctly
  connected* — that is the R22 defect, and importing a server with forty tools would
  reproduce it forty times. Credential resolution must come from the connector the
  capability already declares.

  **✅ P13-0 is BUILT and merged (2026-07-25).** All four seams landed, plus two
  blockers that QA found while using the product. What changed, in plain terms:
  - Atlas no longer guesses whether a step **changes something in the outside world**
    from the step's name — the step declares it, and silence from something that can
    deliver counts as a write. *(`effect` on the capability catalog.)*
  - A workflow delivering to a step outside a hardcoded twelve-entry table can now
    **prove it kept its promise** instead of being blocked from going live.
  - **Picking where a write lands** works for any service that says how its structure
    can be read, not only Airtable. *(`schemaDiscovery` on the catalog.)*
  - **Which account credentials a step gets** comes from the service it declares it
    belongs to, not three hand-typed lists. Six capabilities were silently missing one.

  **Two things a verifier caught that the Builder's own green suite did not**, both
  recorded because they are the pattern, not the exception:
  - The claim that declaring a write makes the **duplicate check and the approval
    check** fire was **false on first ship**. Those two guards ran off a *second*,
    untouched name-matching rule (`isWritingAction` in `workflow-validator.js`), so
    `notion_create_page` and `notion_update_page` — the exact shapes P13-A imports —
    escaped both while the oracle knew they wrote. Now routed through one shared
    `declaresWrite()`, and a declaration can only ever **ADD** a write, never remove a
    guard.
  - The part of the destination fix that **actually runs when a user builds a
    workflow** was pinned by no test at all: reverting it left the entire suite green.
    It was a closure nobody could reach, which is *how* a generalization gets silently
    reverted. Extracted and pinned.

  **Two blockers fixed alongside, neither caused by P13** — both found by using the
  product, and both silent:
  - **A workflow writing "today's date" wrote a date over a year wrong**, and Atlas
    certified it: test panel said the promise was kept, the run said Success, the
    dashboard said 100%. Nothing told the model what day it is, so it answered from
    training data. Now every AI step is given the date and told not to guess it.
    *Residual:* nothing checks the model **used** it — the promise-checker still has no
    notion of "today".
  - **The pause button could make a never-tested draft live** — one line promoted any
    non-active workflow to active, with no verification and no trigger arming. A real
    draft was live for 42 seconds during QA. Now only a *paused* workflow may resume,
    and resuming arms its triggers.

  **How this phase gets signed off** — decided by the operator, 2026-07-15, and
  deliberately narrower than P12's:
  1. **The backend works** — behavioural tests, plus proof that one customer's
     data can never reach another's.
  2. **The product works for a real person** — a live, operator-witnessed run in a
     visible browser: connect a service Atlas has never hand-built, build a
     workflow with it, run it, see real data read and written. Recorded in
     `docs/gates/p13.md` with screenshots. **The connect step is half the proof**:
     one button, the service's own consent screen, back to Atlas connected — and at
     no point is the customer asked for a credential or sent to a settings screen.

  **No coverage percentage blocks this phase.** Re-breaking the code to check a
  test notices is a per-fix technique, not a score to chase — chasing the score is
  what stalled P12.

  - *Design: [`docs/architecture/mcp-capability-adapter.md`](docs/architecture/mcp-capability-adapter.md);
    build: [`docs/handoff/p13-implementation-brief.md`](docs/handoff/p13-implementation-brief.md).
    Planning merged (#22, 2026-07-15). Start at **P13-0** — generalize three F-era
    seams (effect-from-STRUCTURE not an id-regex; a `deliver`-node effect fallback;
    connector-generic destination schema discovery, which also wires the built-but-
    unwired `sheets_describe`). Gate `scripts/gates/p13.sh` is progressive and
    fail-closed. Apply the increment-loop review calibration: block only on defects
    a real user can hit that either look like success or destroy something;
    everything else is recorded and carried. Branch per increment off `main` → PR →
    squash-merge; the phase closes only on the final merge carrying `Gate: P13` +
    `Phase:` + `Verified-by:` from a fresh verifier who did not write the code.*
