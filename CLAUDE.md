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
  `sources.json` — an entry is eligible when its PATH is absolute, which includes browser
  uploads: `/rag/upload` persists the files and records the absolute folder path. Only an
  upload where nothing was persisted (image-only) stays RAG-only). `injectFilesystemContext()` in
  `server.js` stamps `_tenantId` into connector-action node configs before each run, mirroring
  the `injectInboxContext` pattern. Called in all four run paths: REST `/workflows/run`,
  scheduler token injector, Slack event dispatch, Airtable event dispatch. Only absolute-path
  entries (added server-side via `/rag/index-folder`) are eligible for workflow file access;
  an upload where NOTHING WAS PERSISTED (image-only) has no absolute path and cannot be
  used; a document upload does persist and IS readable. **This sentence used to say all
  browser uploads were unusable — that was stale and it misled a reader on 2026-07-30.**
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

- **A SEND THAT CAN SILENTLY DO NOTHING MUST NEVER BE THE LAST STEP OF A STATE TRANSITION
  (2026-07-28, witnessed by the operator on prod v1.6.52).** They approved every step of a
  four-step workflow. The canvas read `4 / 4 APPROVED · every step approved`; the panel beside
  it slid BACK to **"Building…"** — with the curated fact rotating underneath, so it looked
  alive — and Run test stayed greyed out under *"Confirm every step to start testing"*, forever.
  Their words: *"when I accepted the last step it went back into chain of thought mode instead
  of releasing the test."*
  **Cause: `_send` opens with `if (!tid) return;`** — a silent discard when there is no thread.
  Approving the last step set `thinking: true`, locked the composer, and then called it. With
  no session the request never left the browser, nothing errored, and nothing retried. **The
  client had already committed to the new state before finding out the send was a no-op.**
  **Two doors lead to a null thread with the walkthrough still on screen, and BOTH were
  reachable:** `_buildLost` — the "your work is safe" path taken when the connection drops —
  nulls the thread and deliberately does NOT clear `awaitingGraphApproval` (the build really is
  safe on disk); and reopening a draft from the sidebar does the same at three sites.
  Confirmed against the prod event log: the graph sat paused at `walkthrough` for 21 minutes,
  and the last `/respond` was the PLAN acceptance 31 seconds *before* it — no respond was ever
  sent for the four step confirmations. **A paused server and a "thinking" client were the same
  silence.**
  **Fixed at the caller, not in `_send`:** with no session the acceptance is purely local, so it
  lands in the state the reopen path already assumes — confirmed, `phase: 'proposed'`, testable
  — rather than waiting on a ghost. `_send`'s silent return is left alone deliberately; making
  it throw would turn every benign late call into an error bubble.
  **The generalisation:** anywhere a handler sets an optimistic state *and then* calls something
  that can decline to act, the decline must be a branch the handler takes, not a condition it
  never learns about. Pinned by `tests/api/walkthrough-accept-no-session.test.js` (9), which
  extracts and executes the real `_liveApprove` and `_testUnlocked`; two mutations red→green
  (removing the no-session branch → 4 red; dropping just its `phase: 'proposed'` → 1 red).
  **Witnessed live before the fix; the fixed version is code-proven and a live re-check is
  pending.**

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
  one. The domain was closed in one place (`plan-provenance.js`) and applied **twice on
  purpose**: server-side in the `plan` node so a client that never ran could not receive an
  unlabelled item, and in the browser. **And the plan must not settle a question another
  stage asks properly** — a destination that does not exist is the create-or-pick
  conversation's decision, not the plan's to pre-announce.
  **THE FEATURE THIS DESCRIBES WAS REMOVED ON 2026-07-27 — see the entry at the end of this
  section. The two rules above outlived it and still hold:** *a label that makes a claim
  about the USER must fail toward the WEAKER claim*, and *the plan must not settle a question
  another stage asks properly.* The second is still IN THE CODE and still pinned, in two
  places — `tests/converger/plan-grounding-prompt.test.js` and
  `tests/converger/plan-gate.test.js` (put "Atlas will CREATE the channel" back into
  `prompts.js` and both go red; measured 2026-07-27). The first is now advice, because there
  is no longer a label on the plan card to get wrong; **apply it to the next label anyone
  designs.**
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

- **A GUARD THAT DOES NOT RECOGNISE A VALUE MUST NOT READ THAT AS "NOTHING TO CHECK"
  (2026-07-27, Charles: "fix the reason why malformed triggers keep happening").** QA found
  an Airtable-triggered workflow whose first approval card read *"A new email arrives"*. The
  caption was the visible half and the cheap half. The real defect was underneath: its stored
  trigger was `{"type":"connector_event"}` — **no connector, no event, no baseId, no
  tableId** — and **it published anyway**. Across 59 stored workflows, **zero** carried a
  properly-shaped `type:"event"` connector trigger and **eight** carried this one.
  **The fail-closed publishing rule of 2026-07-24 was not weakened — it was BYPASSED**, and
  the mechanism is the lesson: `checkAirtableTriggersArmable` filters with
  `isAirtableRecordChangedTrigger` (`type==='event' && connector==='airtable'`), a malformed
  trigger matches nothing, the filtered list is empty, and the function returns `{ok:true}` —
  *"nothing to arm"*. **Absent and unrecognised were the same answer.** So the workflow saved,
  showed as live, and could never fire: the exact silent failure that rule exists to prevent,
  reopened through a door it did not cover. Slack dispatch has the identical blind spot.
  **The bitter detail: the right refusal already existed three lines below** —
  `TRIGGER_NO_BASE` says *"it does not say which base to watch — so it could never start."*
  That is precisely the condition these workflows were in. They never reached it.
  **Where they came from, and this is the part to remember:** `connector_event` was never a
  runnable type. It appeared in **exactly one place in all of `src/`** — the elicitation
  prompt at `elicitation-graph.js`, listing it among the types the model may return. Nothing
  consumed it: not the scheduler (`type==='email'`), not the Gmail poller, not the Slack or
  Airtable dispatchers. **The interview was asking the model for a value the runtime cannot
  honour**, and a second defect kept it alive: `mergeGeneratedSpec` chose triggers by ORIGIN
  (`existingTriggers.length ? existingTriggers : genTriggers`), so a thin draft trigger
  gathered early **beat the complete shape the model later produced**, base and table
  included.
  **Fixed in three places, deliberately, because each alone would have failed:**
  · `src/workflows/trigger-runnable.js` — **the mechanism, and the only part that holds
    regardless of what any model emits.** One question of every trigger: *is there anything
    in this system that could ever start a workflow from this?* Runnable set is
    `email · schedule · manual · event`, and `event` **must name a connector** because every
    dispatcher matches on it. Anything else is refused, in words a person can act on, at BOTH
    publish paths (`POST` and the `PUT` that is the real publish path for most workflows) and
    **before** the connector-specific checks, which only recognise their own shape.
  · The prompt no longer offers `connector_event`. **That is a BELIEF about model behaviour
    and is pinned by nothing** — the guard is what makes it safe to be wrong.
  · `mergeGeneratedSpec` still lets the draft win — a regenerate must never overwrite what the
    user actually said — **with exactly one exception: it will not throw a runnable trigger
    away for an unrunnable one.** It never promotes the model over a usable answer.
  **The generalisation, which is why this is filed here and not as a connector note:** a
  trigger type added to a prompt but never taught to a consumer now **refuses to publish
  loudly** instead of publishing and silently never firing. Keep the runnable set in step with
  the consumers; this check failing a publish is the signal that someone added one without the
  other. Pinned by `tests/workflows/trigger-runnable.test.js` (15), **three mutations
  red→green** (admitting `connector_event` to the runnable set → 6 red; reverting the merge to
  origin-precedence → 1 red; dropping the connector requirement on `event` → 2 red).
  **NOT fixed, deliberately: the eight existing rows.** They cannot be repaired — the base and
  table were never captured, so a migration would mean inventing identifiers nobody recorded.
  All eight are drafts or errored; none is live. With the guard in place they now refuse to
  publish and tell the user to pick a base, which is the correct outcome. Real examples are
  preserved at `~/Desktop/agent-org/runs/2026-07-27/evidence-workflow-dbs/`.
  **Never witnessed in a browser** — proved by tests and by reading the stored data.

- **A CAPTION IS A CLAIM. AN UNRECOGNISED VALUE MUST NOT BORROW THE WORDING OF THE ONE
  YOU KNOW (2026-07-27).** The companion to the entry above, and reported by **two
  independent QA runs** before it was fixed. The step-approval card — the product's
  designated human safety check — presented an **Airtable**-triggered workflow as
  *"A new email arrives"*, envelope icon included, with the wrong sentence **inside the
  confirm control itself** (`Confirm this step: A new email arriv…`) and **no second,
  correct field on the card to catch it against**. The canvas had the mirror-image bug:
  `_specTriggerTitle` called **every** connector event *"A message is posted"* — Slack's
  wording — including a record change in Airtable.
  **Both were pure-display defects over CORRECT configuration.** The workflow did the
  right thing; only the English was wrong. That inverts the usual shape here and is worse
  than it sounds, because that screen exists precisely so a non-technical person can catch
  a mistake *by reading it*.
  **Two causes, and both are the same mistake:** the approval caption mapped `email` **and**
  the unrunnable `connector_event` to the email wording (and to `mode:'email'`, which is what
  draws the envelope), while the canvas caption had one branch for `event` carrying Slack's
  sentence for every connector that would ever exist. **Each guessed toward the case it
  happened to know.**
  **Fixed as ONE function** — `_triggerCaption` in `public/index.html`, with
  `_triggerIsMail` deciding the icon, and `_specTriggerTitle` reduced to a call into it.
  Written as one on purpose: two copies of a labelling rule is a shape this file already
  records paying for twice (the decision-table grammar, the template-reference rule), and
  **these two had already drifted apart** — which is how the same screen managed to be
  wrong in two different directions at once. The event id is preferred over the connector
  because it is more specific; an `event` with **no** connector says *"a connected app"*
  rather than naming one; and the legacy `connector_event` now says *"Something starts this
  workflow"* — honest — instead of claiming email.
  **THERE WERE FIVE RENDERERS, NOT TWO, AND ONLY DRIVING THE APP FOUND THE OTHER THREE.**
  The canvas and approval card were fixed first and looked complete. Testing in a headed
  browser then showed the **console view** — the screen you land on *before* the builder —
  still calling the same Airtable workflow **"Schedule"**, with a **clock icon**, and showing
  the raw string **`connector_event`** to the customer as a status chip. Three more places
  were each deciding this independently: the console rail (inline in `renderVals`, which gave
  a clock to anything non-email and hardcoded the word "Schedule"), `_triggerTitle` (which
  title-cased the RAW type, so the legacy trigger read as *"Connector_event"*, and knew
  nothing about connector events at all), and `_getTriggerInfo`'s fallback (which used
  `label: t.type` — the chip). All now route through the one rule, and the ICON does too, via
  `_triggerGlyph`: the clock and the envelope are claims, and an unknown trigger gets a
  hollow circle that says *we cannot tell* rather than borrowing either.
  Pinned by `tests/api/trigger-caption.test.js` (18), which **extracts and executes the real
  method sources** out of the page rather than copying them (the same harness as
  `step-approval-card.test.js` — a copy is exactly what would drift, and a grep would pass
  against broken code). **Six mutations, and ONE SURVIVED THE FIRST PASS — the test was
  strengthened rather than the mutation dropped.** Reverting the console rail to the clock,
  the raw tag and "Schedule" left **all 17 other tests green**, because that rail is inline
  inside a ~1,000-line render method that cannot be extracted and executed. That is the
  "generalisation silently reverted in a closure nobody can reach" shape this file already
  records. It now has a **SOURCE-level pin, and the test says in its own header that this is
  weaker than the rest and why** — replace it with a behavioural check if that rail is ever
  made extractable.
  `.claude/skills/atlas-product/SKILL.md` §5 extended in the same commit, because a stale
  behavioural contract is what let two QA runs disagree about whether this was worth
  reporting.
  **WITNESSED IN A BROWSER (2026-07-27), and here is exactly how far that goes.** Proved
  live: the Airtable workflow's canvas, console rail and status chip all stopped saying email
  or schedule; a real Gmail workflow kept its envelope and its wording, so the fix did not win
  by making everything generic. **NOT proved live, and do not claim it:** the *"names the
  app"* path — *"Something changes in Airtable"* — was never rendered, because **not one of
  the 59 stored workflows carries a properly-shaped `event` trigger**, so the browser could
  only ever show the fallback. And the **step-approval card itself** — the surface QA actually
  reported — was not seen, because every workflow on hand is fully approved and no confirm
  control exists to look at. Both need one fresh build to close.

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
  every corpus. The legend was reworded, not removed. Pinned by `plan-said-words.test.js`
  (34, including the REAL `POST /api/builder/sessions` driven end to end to the plan card,
  because "computed and dropped at the POST" is exactly how the run-summary defect worked).
  **Thirteen mutations, TWO survived the first pass and the fixtures were strengthened rather
  than the mutations dropped:** admitting `clarifications` into the corpus changed nothing in
  a graph-driven test because the plan gate fires *before* the elicitation that fills that
  array, and coercing a non-string turn with `String(t)` was invisible until a test asked what
  `"[object Object]"` certifies. A third find: the stopword rule had been written twice and
  **the second copy was dead**. **Never witnessed in a browser — and it never will be: the
  whole feature was removed the same day. See directly below.**

- **THE PLAN CARD'S MARKS WERE REMOVED ENTIRELY (2026-07-27, Charles's call — this reverses
  the decision recorded in the entry directly above, made the same morning).** Both halves
  went: the word-level highlighting of the customer's own words AND the per-line
  `you said / I found / I inferred` badges. **The reason is not that it was broken — it
  worked, and QA confirmed the demotion half held on every build. The reason is that the
  complexity was not worth what it delivered.** Charles: *"I don't want badges at all. And so
  if I can't have badges or if I can't have highlighting that works properly, just get rid of
  it entirely."* The QA manager's recommendation — keep the badge, drop only the highlighting
  — was **put to him and rejected in the room**. Do not re-add a reduced version, and do not
  treat this entry as an invitation to design a better mark. **The plan card now shows its
  trigger, numbered steps, routes and failure line as plain text, and nothing on it makes a
  claim about who said what.**
  **Deleted:** `src/converger/said-words.js`, `src/converger/plan-provenance.js`. **Removed
  from live code:** the `humanTurns` state channel and the whole `typedTurns` path
  (browser → `POST /api/builder/sessions` → `converger.run` → the graph), the per-line
  `confidence` field the plan prompt used to demand, the card's legend, chips and spans, and
  the four client helpers that coloured them.
  **THE LESSONS OUTLIVE THE FEATURE AND ARE STILL BINDING — they are why this entry is long
  instead of a one-line deletion note:**
  · **A label that makes a claim about the USER must fail toward the WEAKER claim.** A mark
    that is usually right is worse than no mark, because it teaches the reader to trust the
    occasional false one. There is no such label on the plan card now; **apply this to the
    next one anyone designs, anywhere in the product.**
  · **A check scoped to WHO PRODUCED a value, rather than to WHAT THE VALUE CAN BE, is a
    laundering hop.** Closing the SET a label may come from validates its vocabulary, not its
    truth — which is exactly how a well-formed `"stated"` over invented content sailed
    through. This is the same shape as the moat's `LLM_INPUT_NOT_ENUM` rule and the
    `isWritingAction` name-matching defect; it is now on its third appearance in this file.
  · **An allowlist of "what a human actually typed" is not reconstructible after the fact.**
    `intent` is model-written, `clarifications[]` is partly machine-authored, and `isOperator`
    is not "typed" — every message Atlas composes and the user merely clicks wears their
    avatar. Anyone tempted to prove a claim about a customer against server-side state should
    read the entry above first: there was nothing on the server that qualified.
  **What deliberately did NOT come out with it, and is still pinned:** the plan must not
  pre-announce that Atlas will create a Slack channel the tenant does not have — that is the
  create-or-pick conversation's decision, after the build (it was welded into the same prompt
  string as the confidence instruction). Two pins, both hand-mutated red on 2026-07-27:
  `tests/converger/plan-grounding-prompt.test.js` and `tests/converger/plan-gate.test.js`.
  **Test files re-pointed, not deleted:** `plan-provenance.test.js` →
  `plan-grounding-prompt.test.js` (it now pins only that surviving rule, plus that the prompt
  never grows the marks back); `plan-said-words.test.js` → `plan-card-e2e.test.js` (its
  assertions were feature-specific but its HARNESS is the only one in the tree that drives the
  real `POST /api/builder/sessions` through a background build and polls `/status` to the plan
  card — it now proves the card is reached and every row arrives renderable). `plan-gate.test.js`
  was edited in place; its four unrelated guards (fires exactly once; the approved plan
  reaches the build; the fail-safe skip on an unusable projection; the pre-selected default)
  were each hand-mutated red→green.
  **One residual, found by mutation and NOT fixed (out of the packet's scope):** the "the plan
  is shown exactly once" property is guarded twice — the `_planShown` latch on the plan node
  and the `_generated` check in the `analyze` router (`elicitation-graph.js`) — and **removing
  either one alone changes nothing observable, so neither is individually pinned.** Only
  removing both turns the guard red. It is belt-and-braces where the record implies one
  load-bearing latch.

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
  **Pinned by `tests/api/build-offer-actionable.test.js` (11), eight mutations red→green.** Read
  the honest split in that file's header: the behavioural half drives the real
  `POST /api/builder/chat` and pins the **mechanism** (`ready_to_build:true` → SSE `done`
  `readyToBuild:true` with the intent riding along), which **nothing anywhere asserted before**
  — `grep -rn "readyToBuild" tests/` returned nothing at `7858ef9`. The prompt half only pins
  the **instruction**; whether the model complies is a belief no test can prove.
  **BOTH copies of the mechanism are now pinned, because there are two (2026-07-27).** The
  endpoint writes that `done` event in two places: the ordinary one inside the tool-round loop,
  and the **forced-final** one taken when the model burns `MAX_TOOL_ROUNDS` without replying
  (landed `601cb34`, 2026-07-15) — one more turn with tools switched off, reading
  `ready_to_build` and normalising `build_intent` all over again. The first fix's four guards
  were **blind to the second copy**: hardwiring the forced-final flag to `false`, to `true`,
  dropping its `build_intent`, or leaving tools on that final turn all left the original eight
  green. Unlike the retry, **this path is not hypothetical** — `forcedFinal:true` appears on a
  real `chat.reply` line, once, at `2026-07-15T12:31:44.826Z` (it carried `readyToBuild:false`,
  so the *offer* case on that path remains unobserved; do not claim it either way). Its fixture
  must hand the endpoint **real tools** — with an empty tool list the budget can never be burned,
  so the test would exercise a path production cannot take *and* the "the final turn is issued
  with tools DISABLED" assertion could not fail.
  **The contract doc taught the workaround, and that is why the defect survived QA.**
  `.claude/skills/atlas-product/SKILL.md` §1 said in as many words *"the user's only escape is
  to type 'build it'"*, and the QA report records all four testers recovering by typing it
  *"which they knew only because the product's own contract document told them."* A tester
  handed the password cannot report the lock. §1 is rewritten (same commit): an offer with no
  button is the finding, nobody is told to type anything, and the retry is described as a path
  never yet taken rather than as the normal recovery.
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
   entry shown once per user on next login). Stages the change to commit *with* the code —
   `package.json` **and `package-lock.json`** (both are rewritten by `npm version`), plus
   `release-notes.json` when notes are given. **The lockfile was omitted until 2026-07-27
   and drifted six versions** (committed lock said 1.6.36 against a 1.6.42 manifest) before
   anyone noticed; `npm ci` does not fail on that mismatch, so nothing broke — the repo
   simply disagreed with itself about what version it was. Pinned by
   `tests/gates/release-stages-lockfile.test.js`, which runs the real script in a throwaway
   repo.
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
  so with a mail credential in the environment that gate step really sends **two approval
  emails, each carrying a live single-use approval magic link**, still prints
  `APPROVAL-ADVERSARIAL-PASS` and exits 0. `Promise.allSettled` swallows the outcome, so the
  send is silent. It got away with it only because that one invocation happens to omit
  `--env-file` while every other `node` call in `p12.sh` has it — "no gate step sends mail"
  was an accident of a list, not an invariant. (Measured against a local SMTP catcher,
  2026-07-27: 2 messages without the lockout, 0 with it, same env file and port.)
  **Who actually receives it, verified 2026-07-27:** `ops@acme.test` is the *only* recipient
  in any gate-reachable check, and `.test` is a reserved, non-routable TLD (RFC 2606) — so no
  person is emailed **today**. Say it that way and no other: the exposure is not about the
  recipient. An outbound send still leaves the machine carrying live approval tokens, and
  **nothing anywhere checks the address**, so a fixture naming a real one at any point in
  future mails a real person on the same code path with no further warning.
  **The mechanism is `scripts/gates/_no-mail.sh`**, sourced after the `cd` by `scripts/gate.sh`
  and by **every gate script that spawns `node`** — the `pN.sh` phase gates (each runnable
  directly, which bypasses `gate.sh`) *and* the six `cap-*.sh` capability checks, which
  `gate.sh` cannot reach at all. (`p6.sh` is scrapped, spawns nothing, and is exempt.) It
  exports `RESEND_API_KEY`, `MAIL_FROM`, `SMTP_*` and `GMAIL_*` **empty**, which wins: measured
  on Node v22.22.2, `--env-file` and `--env-file-if-exists` do **not** overwrite a variable
  already in the environment, and an empty string counts as present. So every descendant is
  covered — including a step added later that nobody remembered to guard, and one invoked
  *without* `--env-file` that would otherwise inherit a key exported in the operator's own
  shell. It then **proves it and refuses to run** if `mailerConfigured()` is still true,
  rather than running and hoping. **`ANTHROPIC_API_KEY` is deliberately untouched** — the gate
  loads `.env` for exactly that key (`full-journey.test.js` self-skips the converger test
  without it; that is how P11 was nearly closed on a false pass) and the lockout must stay
  targeted at mail.
  **Pinned by `tests/gates/gate-cannot-send-mail.test.js` (10), which is SELF-CONTAINED**
  (2026-07-27): it never inspects its own process's environment. Each test builds the gate's
  conditions itself — a throwaway env file *and* a shell export, both carrying fabricated
  credentials, and a child spawned the way a gate step is spawned with the lockout applied —
  so it gives the **same verdict standalone, under the gate, and with or without a `.env`**.
  The gate-bound predecessor did the opposite: it read the ambient environment, so it passed
  vacuously where there was nothing to find and was **red under plain `node --test`**, which
  put a fake broken-product failure in the suite. If a check can only pass in one invocation,
  that is a defect in the check. Every fixture is asserted live in an unprotected control, so
  no case can quietly stop being a credential; the **refuse-to-run probe** is pinned by
  deriving a copy of the lockout at runtime with one `export` removed (nothing else can reach
  it — with a complete strip list the probe can never fire); and a wiring assertion enforces
  *no gate script spawns `node` without sourcing the lockout first*. Hand-mutated red→green
  three ways: strip line removed (5 red), probe neutralised (1 red), `source` line deleted
  (1 red). **No product code guards sending** — `mailer.js` gained only a corrected doc
  comment. **Accepted consequence:** the gate no longer exercises the email approval channel
  at all. That is *not exercised*, not *passing* — sending is known to work from the
  operator's own use, which is not a measured result.

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
  ever asks for. Made benign for the "you said" invariant 2026-07-26; that invariant went with the marks on 2026-07-27, so this residual now stands on its own and is still not closed.
- **Two copies of the "what counts as a template reference" rule** — the build-time probe
  (`node-types/assemble.js`) and the run-time escaper (`template-escape.js`) each carry their
  own `\{\{[^}]+\}\}`. They agree today because the second was written to match. This repo
  has already paid twice for this shape on the decision-table grammar. Collapse them when
  anything next touches either.
- ~~**The diagram's type tag is still jargon**~~ — **CLOSED 2026-07-29.** It was worse than
  this entry recorded: there were **three** vocabularies for one set of steps, not one, and a
  customer met all three in a single sitting — the canvas said `LLM · EXTRACT` /
  `CONNECTOR-ACTION`, the **on-screen** procedure document had its own private table saying
  `LLM PROMPT` / `EMAIL TRIGGER`, and the **exported** document said "AI step" / "Wait for a
  person". Now one table (`_stepTypeWords`, read by `_nodeShape` and the document view-model)
  with the exported generator's tables written to match, and the words say what the step DOES
  ("ASKS A PERSON", "PICKS A PATH", "SENDS IT"). An unrecognised type says "STEP" instead of
  shouting its raw name, which is what the old `(T || 'step').toUpperCase()` did to every node
  type nobody had taught it. Pinned by `tests/api/plain-english-surfaces.test.js` (34), eight
  mutations red→green.
- **A WORKFLOW THAT SET ITSELF UP ON EVERY RUN WORKED EXACTLY ONCE — FIXED
  (2026-07-29).** Asked to write four fields into an Airtable table that had four
  different ones, Atlas did the right thing conversationally — read the real
  columns, proposed a mapping, offered to add the two missing — and then put those
  two `airtable_create_field` calls **inside an email-triggered workflow**, so every
  incoming email would re-add the same columns. Airtable refuses a duplicate field
  name, the api helper throws on any non-2xx, and by the workflow's own failure rule
  the run stops there — before the record and before the Slack post. **Its own
  safety net could not see it: the dry run stubs writes, so the step that would fail
  never ran.** It passed, and would have gone live.
  **Two fixes, both needed.** `airtableCreateField` is now IDEMPOTENT — it looks the
  column up first and absorbs a duplicate error from a race — which has to hold
  wherever it is called from, since a re-publish, an edit or a retry all call it
  again. And the PLACEMENT is refused at build time (`SETUP_ACTION_AS_STEP`) from a
  **declared** `oneTimeSetup` trait on the capability, read through
  `declaresOneTimeSetup` beside `declaresWrite` — one catalog, one declaration, two
  readers. **Declared, not inferred from the id, because `airtable_create_field` and
  `airtable_create_record` are indistinguishable to any name test** and one is setup
  while the other is genuinely per-run work; a name-matching rule has been the defect
  here three times already. The gate fails OPEN on an unknown capability: it refuses
  a build, so silence must never be able to block one. Pinned by
  `tests/workflows/one-time-setup-not-a-step.test.js` (17), **ten mutations
  red→green — three survived the first pass and the tests were strengthened rather
  than the mutations dropped**: a name-regex substitute, absorbing every error as
  "already exists", and the registry dropping the trait were all invisible until the
  fixtures stopped agreeing with the id and a test drove the REAL registry.
- **A SCHEDULED WORKFLOW RAN FIVE HOURS EARLY AND SAID IT WAS ON TIME — FIXED
  (2026-07-29).** Measured on prod: THREE stored schedule triggers, every one
  `{"type":"schedule","cron":"0 17 * * 1-5"}` with **no `timezone` field at all**,
  beside a workflow named "Every weekday at 5pm CDT" and a plan card reading
  "5:00 pm CDT (America/Chicago)". The scheduler was not at fault — it reads
  `t.timezone ?? t.config?.timezone ?? deploymentTimeZone()`, and honouring the
  declared zone was itself a recorded fix. But **the prod box is Etc/UTC**, so a
  trigger declaring nothing fires at 17:00 UTC — *noon* in Chicago. The run
  succeeds, the dashboard is green, and the workflow is five hours early having
  told the user to the minute when it would run. Silent, user-reachable, looks like
  success. **The prompt had asked for a zone all along and the model kept omitting
  it** — a prompt is a belief about model behaviour, so the fix is the mechanism
  that makes being wrong about it harmless: `stampScheduleTimezone` fills a blank
  zone from the browser's, at the one point every build passes through
  (`mergeGeneratedSpec`, after the draft-vs-model choice, so it applies whichever
  side won). It **never overrides a declared zone** — the model may know something
  the browser does not. Pinned by `tests/converger/schedule-timezone-stamped.test.js`
  (10), two mutations red→green. **Existing rows are NOT migrated** — their intended
  zone was never captured, so a migration would mean inventing one; they keep
  falling back to the deployment zone until edited.
- **The sufficiency repeat-guard was defeated by rephrasing — FIXED (2026-07-29).**
  The guard added on 2026-07-28 compared the first 200 characters of the critic's
  complaint, so it only caught a WORD-FOR-WORD repeat. On prod
  (`build-platform-1785296845055`) the critic ordered four rebuilds of one workflow
  — 5m24s, stopped only by the cap — saying the same thing four different ways
  ("classifies the entire batch…", "Per-email classification:", "Per-email
  classification step —", "must extract individual email details…"), so it produced
  four different keys and never fired once. **The same shape this file records
  repeatedly: a check scoped to the FORM a value takes rather than to what it
  MEANS.** Now compares content words (`sameComplaint`), with thresholds MEASURED
  against those four complaints — every pair shares ≥5 words, five genuinely
  different complaints share ≤2 — not guessed. The anti-false-positive cases matter
  more than the catch: a guard that suppressed real findings would hide defects
  instead of a loop.
- **A correct workflow was told it delivered nowhere, and paid for three rebuilds
  — FIXED (2026-07-29).** Prod `build-platform-1785337840769`, from a deliberately
  vague opener. The workflow was right: Gmail trigger → classify → branch → create a
  Google Task. The oracle said *"nothing reached "My Tasks" in tasks — this run
  delivered to `{{extract_email.subject}}` (tasks)"*. `tasks_create` takes
  `{title, notes, due, tasklistId}`; the oracle's fallback `LOCATOR_KEYS` list —
  key names that USUALLY name a destination — contains `title` and not `tasklistId`,
  so it reported the task's own NAME as the place it was written. **The fifth
  instance of a rule scoped to the FORM of a name rather than to what it MEANS.**
  Capabilities now DECLARE `locatorKeys` (+ `defaultLocator` for a provider default
  like Google's "My Tasks"); the guess list survives only for capabilities from
  sources we do not control. Two places decided this — `nodeEffect` and
  `normalizeDelivery`, the second being the RECEIPT the runtime check matches — and
  they had drifted; both now read the one declaration, and the handler returns the
  list it actually wrote to so a real run can correct a wrong declaration. Also
  caught in passing: `gmail_get_message` matched the `message_sent` verb regex, so
  **reading** mail satisfied a promise to **send** it. Pinned by
  `tests/workflows/write-destination-declared.test.js` (21, 9 mutations killed).
- **"Don't pay twice for the same complaint" had been written three times, once per
  route — REPLACED WITH ONE GATE (2026-07-29).** `_lastShape`, `_lastBlockerKey`,
  `_lastMissingKey` were each added after their own incident, each compares a route
  only against ITSELF, and `verify_failed` — which orders the most rebuilds — had
  none. So the ONE false fact above was discovered by three different nodes and
  bought three whole-spec Opus passes: `blocking_gaps` "UNSATISFIED_ASSERTION",
  `gap_answer` "promises tasks:My Tasks, but no step…", `verify_failed` "nothing
  reached My Tasks" (twice, byte-identical). 355s of Opus, ~$1.40, on a spec correct
  after pass one. **This is the rule-duplication defect applied to the guard against
  rebuilds.** Now one gate at `generate` — the single place every route arrives —
  keyed on `_regenReason`, the single thing every route already sets, so a route
  added later inherits it instead of arriving unguarded. Complaints are compared by
  **the promise they concern** (`about`, normalised to the assertion target), not by
  wording: measured, `sameComplaint` needs `minShared:1` to pair the gap and verify
  sentences, at which point it pairs nearly everything. That required the validator
  to carry `target` as DATA on `UNSATISFIED_ASSERTION` — it existed only inside an
  English sentence. Matching against every complaint so far, not just the last, also
  catches A→B→A thrash. Measured end-to-end through the real graph: an unfixable
  structural failure costs **6 dry runs, was 9**; the prod sequence replays as **2
  paid passes, was 4**. `_regenReason` is consequently **no longer diagnostic only** —
  a route that forgets to set it yields an empty detail and can never be gated, so a
  missing log label still cannot fail anyone's build. Pinned by
  `tests/converger/rebuild-only-for-a-new-complaint.test.js` (25, 10 mutations killed).
- **A quiet path was scored as a broken promise — FIXED (2026-07-29).** Prod: a
  pricing-enquiry workflow (Gmail → classify → branch → draft → Slack approval →
  send, with a silent stop for anything else). 12 examples, 10 kept, and the two
  labelled *"Non-pricing email — should not trigger workflow"* reported as BROKEN —
  for sending nothing, which is exactly what they were for. `broke > 0 ⇒ 'failed'`,
  so it could not go live. **The cause was evaluation order:** `!ran || broken ||
  !contract.every(ok) ? 'broken' : (negative ? 'not_exercised' : …)` — a negative
  that correctly delivers nothing fails its assertions BY DESIGN and short-circuited
  to `broken`, never reaching the branch written for it, which was reachable only
  when a negative HAD delivered. Two prior fixes (07-21, 07-23) both changed WHICH
  samples count as negative; neither touched WHEN the negative test is consulted.
  **It also punished the better design** — a trigger-filter workflow lets the
  negative through, delivers, and lands on `not_exercised` correctly; only the
  in-flow classifier with a silent stop failed. A crash or content sentinel is still
  `broken` for a negative; only the CONTRACT result is excused, and `contractPassed`
  is untouched (verify reads it — flipping it is the F17 regression through a new
  door). Pinned by `tests/workflows/quiet-path-is-not-a-broken-promise.test.js`
  (12, 4 mutations killed).
- **The trigger was the one part of a spec its owner could not change — FIXED
  (2026-07-29).** Asked to stop matching pricing emails on subject keywords, Atlas
  re-planned and showed *"no subject-keyword filter — the AI reads every email and
  decides"*; the built workflow kept `subject:(pricing|price|cost|plan|subscription)`
  and so contained its own contradiction — a classifier instructed with *"How much
  for the team package?"* as a positive, behind a trigger that would never pass that
  email. Verify passed. The trigger is derived ONCE in `process`
  (`if (!triggers.length)`) from the intent before the interview ends, and never
  revisited; then TWO mechanisms pinned it — `mergeGeneratedSpec` prefers the draft's
  triggers, and `buildGeneratePrompt` seeds the model with them under *"ALREADY
  DERIVED … do not contradict them"*. Both exist to stop a MACHINE rebuild
  overwriting what the user said, and neither distinguished the machine from the
  person. Both are now relaxed **only** when `userRevisedThisBuild()` — a change
  asked for at the plan, the walkthrough or ratify — and never for a
  machine-ordered rebuild; a revision still cannot lose a trigger or promote an
  unrunnable one. Pinned by `tests/converger/user-can-revise-the-trigger.test.js`
  (13, 6 mutations killed).
- **A login email is not a Slack account — FIXED (2026-07-29).** The converger's
  system prompt said, unconditionally, *"when they say DM me, use
  `{channel:'slack_dm', user:'<their ATLAS LOGIN email>'}'"*, and nothing had checked
  the two identities were the same. They were not: two approval builds addressed
  their DM to `hello@agntic.co` while the workspace's only Slack email is
  `charles@agntic.co`, so every run failed *"no Slack user matches"* — the probe was
  right, the INSTRUCTION was wrong — and neither build could verify. Diagnosed against
  the live workspace first (`users.list` ok, 4 members, `users:read.email` present,
  one page): **not a lookup bug**. The DM target is now resolved from the CONNECTED
  WORKSPACE (`resolveOperatorSlackIdentity`) and an unmatched login is never guessed
  at — the converger is given the members it can see and told to ASK, because DMing
  the nearest match delivers this person's drafts and approvals to a colleague. Fixed
  in passing: `users.list` was read one page deep (`limit: 200`, no cursor), so past
  200 members it silently resolves nobody and "not found" is indistinguishable from a
  wrong address. Pinned by `tests/connectors/operator-slack-identity.test.js`
  (17, 8 mutations killed).
- **Three things a person said, that the product then contradicted — FIXED
  (2026-07-29).** None corrupted a spec; each made Atlas SAY something untrue of the
  workflow it had just built. (a) **The critic argued with the user.** Asked to stop
  matching pricing emails on subject keywords, the build complied — and the fast-tier
  sufficiency critic ordered a whole-spec Opus rebuild: *"the trigger filter should
  filter for the keywords 'pricing', 'plans', 'cost'… not all unread emails"*, reasoning
  from the PRE-revision intent. It lost (a machine rebuild cannot overwrite the user's
  trigger) but cost ~$0.70 and left a contradiction in the log. `userRevisedThisBuild`
  is now a third way the verdict is disproven, beside `sufficiencyClaimAlreadyCovered`
  and the repeat check — the critic still RUNS and still logs
  (`reason: user_revised_this_build`), it simply may not spend a rebuild disagreeing
  with the person. (b) **The promise went stale**: after that revision the trigger
  correctly watched every unread email while the deal still read *"When an email
  arrives containing pricing-related keywords"*. `refreshedOutcome` updates the
  STATEMENT — the half a person reads — on a user revision only; **assertions are never
  rewritten** (a rebuild that could rewrite them could quietly promise less). (c) **The
  approval card never showed the draft**: the `human` node's schema calls `preview`
  "what they actually see", the generator set it correctly to `{{draft_reply.output}}`,
  and the card rendered a question reading *"review the draft reply below"* with nothing
  below. Now rendered via `_plainPreview`, which resolves the reference to the step's
  LABEL rather than printing a raw `{{…}}`. Pinned by
  `tests/converger/user-has-the-last-word.test.js` (12) and
  `tests/api/approval-card-shows-the-draft.test.js` (10); 10 mutations killed.
  *Process note: the client edit shipped a `},` into a CLASS body and the page died
  with `Unexpected token ','` — caught by loading `public/` on :8899 BEFORE deploying,
  which is the rule written after v1.6.65 broke prod the other way round.*
- **Atlas could only ever make ONE kind of Airtable column — FIXED (2026-07-29).**
  Building a lead-intro workflow against the real CRM, Atlas read the Companies
  table, noticed there was nowhere to record that a lead had been contacted,
  proposed an "Intro Email Sent" CHECKBOX, showed it for confirmation, was confirmed
  — and failed: *"Failed schema validation: Intro Email Sent.options is missing"*.
  `airtableCreateField` sent `{name, type}` and nothing else; most Airtable field
  types carry REQUIRED `options` and the only one that does not is the
  `singleLineText` default. So it worked for every column anyone had happened to ask
  for (all text) and could create no other kind — it offered to do something it
  could not do, at the moment the user said yes. Defaults now supplied for checkbox
  / number / percent / currency / rating / date / dateTime / duration; caller
  options always win; select types are REFUSED IN WORDS rather than guessed, because
  their choices are the column's content. **And the failure message is no longer the
  raw API sentence** — an HTTP verb, two opaque provider ids and Airtable's internal
  validator were being rendered verbatim on a chat card; only the schema/options
  family is reworded (auth and rate-limit errors pass through untouched, and the
  original is kept as `cause`). Pinned by
  `tests/connectors/airtable-column-types.test.js` (28, 9 mutations killed). **A second
  defect on the same call, found on the retry:** the schema endpoint
  (`/meta/bases/{base}/tables/{table}/fields`) accepts ONLY the `tbl…` id, while every
  other Airtable capability here — and every person — uses the table NAME, so a retry
  that carried "Companies" got `NOT_FOUND`. The name is now resolved to its id from the
  schema read the idempotency check already performs, and an unreadable schema still
  falls through to the write rather than refusing.
- **The confirm button went dead, silently and for good — FIXED (2026-07-29).**
  A column add failed, the page was reloaded, Atlas re-offered the same action, and
  "Confirm & run" did NOTHING: no request, no console error, no change on screen, no
  way to tell why or to recover. The card's id came from an in-memory counter
  (`"act" + (++self._pc)`) that restarts at 1 on every mount — while the RESTORED
  conversation still holds the cards from before the reload. The new card was minted
  as `act1`, the finished `act1` was still in `msgs`, and the handler looked its card
  up with `.find()`, got the OLD one, saw `status: "error"` and returned. *The guard
  was never wrong — it was reading the wrong card.* Two fixes because either alone
  leaves a hole: ids are seeded per mount, AND the lookup takes the LAST match so a
  conversation restored from before the fix still works. Pinned by
  `tests/api/confirm-button-survives-a-reload.test.js` (6, 3 mutations killed).
- **Templates and a false claim on the last card before a real send — FIXED
  (2026-07-29).** Three leaks on the surfaces a person reads before letting Atlas
  email a stranger. (a) The approval card's `Asks` row printed `cfg.prompt` verbatim
  — *"Review this intro email draft for `{{extract_contact.contactName}}` at
  `{{extract_trigger.companyName}}`"* — DIRECTLY ABOVE the `They also see` row fixed
  hours earlier for exactly this; an earlier build leaked Slack emphasis too
  (`*{{…}}*`). Now `_plainAsk`: references described, `*…*` unwrapped, every other
  word left alone. (b) "Only when it matches: `table:Companies AND field:Relationship
  Status = Lead`" — query syntax on the row that says when the workflow starts
  touching someone's data. `_plainEventFilter` renders it ("in the Companies table,
  when Relationship Status is Lead"); `_plainFilter` could not, being Gmail's grammar
  and whitespace-split. (c) **`_triggerDetail` claimed EVERY event trigger was Slack**
  — "When a message is posted in Slack." for an Airtable record change. Not unclear:
  false, about what starts the workflow. **The reference rule lives in ONE place**
  (`_refPhrase`), shared by `preview` and `prompt`, because two copies is how this
  file keeps ending up with two answers. Pinned by
  `tests/api/no-templates-on-the-approval-card.test.js` (25, 7 mutations killed).
  *Two of those mutations initially survived because the assertions they should have
  broken passed either way — the guard case (`"Monday AND Friday"`) had to be added
  before deleting the guard was detectable.*
- **Atlas told a user their CONNECTED connector wasn't connected — FIXED
  (2026-07-29).** Asked for a weekly CRM digest in a Google Doc, Atlas spent three
  turns designing it (read the real table, caught that the base has no last-modified
  field, agreed the contents), produced a plan, took the approval — then refused:
  *"I can't include gdrive — that connector is not connected, so I won't promise
  something the workflow can't actually do."* **Google Workspace WAS connected.** The
  refusal instinct is right; the premise was false, so a workflow Atlas could run was
  declined and the user was told a working connector was missing. Cause: one missing
  word. `CONNECTOR_ALIASES` spells out `gdocs` and `gcal`; nobody wrote `gdrive` or
  `gsheets`, and `canonicalConnector` only splits compounds on `_`/`-`/`.`, so
  `google_drive` resolved and `gdrive` did not — the same one-word omission as the
  missing `tasks` entry hours earlier, with the same cost. Fixed as the FAMILY (a
  vendor prefix run together with the service name) rather than the instances, since
  the spellings a model may choose are unbounded; `gmail` is returned as itself long
  before it could be shortened to `mail`. Pinned by
  `tests/workflows/connector-spellings.test.js` (29, 1 mutation killed — two further
  mutations proved *unkillable* and the dead guard they exposed was removed rather
  than left untested).
- **A connector's availability is only checked at BUILD time (open).** Three turns of
  design, a plan and an approval all preceded the "not connected" refusal above, and
  `capabilities.connectors` was known from turn one. Even with the alias fixed, a
  genuinely absent connector still wastes the whole interview. Same family as the
  setup-action dead end: the user does everything asked and then hits a wall.
- **THE DECLARATION AUDIT (2026-07-29).** Six times in one day the same defect shape
  was found by a build failing — a rule scoped to the FORM of a name rather than what
  the thing MEANS (`isWritingAction`, the trigger captions, the step-type tables, the
  missing `tasks` alias, `title` in `LOCATOR_KEYS`, the missing `gdrive` alias). Each
  was fixed where it was found; the last landed in a table edited hours earlier
  without noticing its neighbours were also missing. So the whole question was asked
  at once, against the LIVE registry rather than from memory. What it found:
  **19 of 28 capabilities declared no `effect` at all**, so a verb regex decided for
  every one of them — and three were misclassified, all in the dangerous direction
  (writes seen as reads): `gmail_mark_read`, `airtable_create_field`, and
  **`airtable_delete_record`**. The last is the most destructive capability shipped
  and it matched none of `create|append|send|post|add|insert`, so it escaped BOTH
  guards `isWritingAction` feeds: duplicate protection (a double trigger deletes
  twice) and the approval-strength check (a delete authorised by a channel that
  proves nobody). **No build had ever exercised it, because nothing in the product
  promises a deletion** — which is exactly why the audit was worth doing rather than
  waiting for a tenth shape to trip over it. Fixed: `effect` declared on all 16
  reads/triggers and on `airtable_create_field`; destructive verbs added to the
  fallback. `gmail_mark_read` and `airtable_delete_record` are deliberately left
  undeclared — declaring `write` would give them `record_exists` and let a DELETE
  satisfy a promise that something exists. **The vocabulary has no kind for "changed,
  nothing created"; adding one is a real follow-up.** Pinned by
  `tests/workflows/capability-declarations-audit.test.js` (16, 6 mutations killed),
  which walks the live registry and fails when a capability is added undeclared,
  misclassified, unresolvable, or missing its destination — so the next connector
  fails HERE rather than months later as "Atlas said my connector wasn't connected".
  *An existing test also caught the first attempt over-broadening the fallback to
  `update|set|move|rename`: `notion_update_page` is the CONTROL proving a declaration
  does that work. Widening the guess would have made guessing more load-bearing —
  the direction this audit exists to reverse.*
- **Build-time and runtime disagreed about where a Google Doc lives — FIXED
  (2026-07-30).** Driving shape 1 of ten (a weekly CRM digest into a Google Doc), the
  contract said `document_exists → google_drive:New Companies This Week` and the
  delivery went via `docs_create`. `satisfiesAssertion` said SATISFIED;
  `checkAssertionAtRuntime` said *"nothing reached … in google drive — this run
  delivered to … (Google Docs)"*. Two more whole-spec Opus passes were spent trying to
  fix a spec that was already right, and the rebuild gate refused the third. **Writing
  the identical promise as `docs:` passed both halves — the WORDING decided the verdict
  on a correct workflow.** Cause: the build-time half asks whether the wanted connector
  is among the ALIASES of what the node writes to (`docs` carries
  `['docs','google','drive','gdocs']`, because a Doc does live in Drive); the runtime
  half compared two canonical SCALARS, `docs` vs `drive`. **Seventh instance in two
  days of one rule living in two places and drifting.** Both now consult the same
  table via `deliveryReaches`, and the check is DIRECTED, not symmetric: `gmail` and
  `docs` both list `google`, so intersecting the alias sets would let an email satisfy
  a promise about a document — mutation-verified as the real fail-open. Pinned by
  `tests/workflows/both-halves-agree-on-the-connector.test.js` (22, 3 of 4 mutations
  killed; the fourth was proved behaviourally equivalent rather than a missing guard).
- **THE AGREEMENT SWEEP (2026-07-30).** The declaration audit asks *"is everything
  DECLARED?"*. It could never have caught the build-vs-runtime connector drift above,
  because nothing was missing — two consumers of the same table simply asked the
  question differently. So this asks the other question, exhaustively rather than for
  hand-picked pairs (hand-picked pairs are how the first six instances were missed):
  **for every write capability × every connector spelling × both node forms, and for
  every promise against every other capability's delivery, do `satisfiesAssertion` and
  `checkAssertionAtRuntime` agree?** 64 direct combinations and 198 cross pairings, all
  driven from the LIVE registry so a capability added tomorrow is swept tomorrow.
  Result: **0 disagreements, 0 fail-opens** — the class is closed for everything
  shipped. Four mutations confirm the sweep has teeth: reverting the runtime half to a
  scalar comparison (4 red), making it symmetric so an email satisfies a document
  promise (2 red), removing the vendor-prefix spellings (1 red), and stopping the
  BUILD half canonicalising (3 red) — i.e. it catches drift from either side, not just
  the one that was broken. Pinned by
  `tests/workflows/build-and-runtime-agree-everywhere.test.js` (8 assertions over 262
  generated combinations). *Two guards now stand together: declare everything, and
  prove the consumers agree.*
- **A FINISHED BUILD WAS LOST BECAUSE THE USER GLANCED AT ANOTHER WORKFLOW — FIXED
  (2026-07-30).** Charles's own build, witnessed on prod
  (`build-platform-1785414984862`): a daily 6am AI-news briefing emailed to him. He
  started it and, while it thought, clicked two other workflows in the sidebar — the
  server log records it plainly, two `PUT …/draft` autosaves for OTHER workflow ids at
  12:38:36 and 12:38:41. Opening another workflow replaces `state.threadId`, and the
  poll loop's first line is `if (self.state.threadId !== threadId) return;` — **a
  silent return, no message, nothing on screen, no record kept.** The build carried on
  and finished 44 seconds later at 12:39:25: a complete, correct three-step workflow,
  paused at its walkthrough, waiting to be approved. **Nobody was listening.** Coming
  back showed the reasoning and NOTHING ELSE — no steps, no graph, no note, no way to
  reach it; the panel read "Not started" and a reload changed nothing.
  **The result was never gone.** Measured against prod the next day, `/status` still
  answered `status:"ready"` with the entire spec in it. It was unreachable only because
  the sole copy of the build's identity lived in a closure that had returned.
  **That is the defect exactly:** the build was moved onto the server so that "a closed
  tab, a refresh, a locked phone or a deploy no longer takes the build with it" — the
  comment above the poller says so. The server half held. **The browser half was never
  built:** nothing anywhere wrote down WHICH build was in flight, so the only thing that
  could collect the result was the one poll loop that happened to be running. Glancing at
  another workflow while a build thinks for two minutes is an ordinary thing to do, and it
  cost the whole build.
  **Fixed in three parts, because any one alone leaves the hole:** the thread id is
  written to `localStorage` when the build starts (`_rememberBuild`); the "conversation
  moved on" return stops POLLING but deliberately keeps the record; and reopening the
  conversation asks the server and draws what is waiting (`_pickUpPendingBuild`, called
  from `_applyBuildSlice` — the one place both a page load and an in-app reopen pass
  through, so neither door can lose it silently). The record is cleared only once the
  build has been **SEEN** — drawn, lost, or failed — because clearing it on receipt would
  drop the build in the exact case it exists for. It refuses to draw across
  conversations: the match needs a workflow id known on BOTH sides, since `null === null`
  on a first build would render one conversation's workflow into another. Pinned by
  `tests/api/a-build-survives-you-looking-away.test.js` (22), **nine mutations red→green**.
  *Two other harnesses' component doubles broke on the new method call and were given it
  — the fifth time this extract-and-execute family has needed a manual list update.*
- **THE SLACK IDENTITY GUIDANCE LEAKED ONTO AN EMAIL-ONLY WORKFLOW, AND COST THREE OPUS
  PASSES — FIXED (2026-07-30).** Same build as above. Its contract promised
  `message_sent → gmail:hello@agntic.co` (the login, correct for email) while the only
  delivery step was built to `charles@agntic.co` — so the promise and the send named two
  different people, `UNSATISFIED_ASSERTION` fired, and **three whole-spec Opus passes
  were spent trying to reconcile a contradiction the prompt itself had created** before
  the rebuild gate refused the fourth. Charles was also asked which Slack account was
  his, about a workflow with no Slack in it.
  **Cause: `operatorSummary` stated every fact about Slack without saying it was about
  Slack.** The 2026-07-29 fix (a login email is not a Slack account) was right and is
  intact; it was simply phrased as though *"send it to me"* always meant a Slack DM. On
  the CANDIDATES branch that handed the model a second address under the heading *"the
  workspace members you could DM"* plus an instruction to ASK which of them is the user
  — and the model, building an email workflow, used the Slack member address as the email
  recipient and raised the Slack question.
  **The instruction was not wrong about Slack; it was wrong to be silent about which
  channel it governed.** *"Send it to me"* names a PERSON, not a transport. Every sentence
  is now scoped to its channel, the login email is named as the address to EMAIL them at
  in all three states, the ask-which-is-you fires only if the workflow reaches them in
  Slack at all, and the invariant is stated outright: **the promise and the step must name
  the SAME address.** Pinned by the new block in
  `tests/connectors/operator-slack-identity.test.js` (25 total), four mutations red→green;
  the guards the earlier fix added are asserted still present, so the scoping cannot
  become an escape hatch. *Load-bearing prompt sentences are kept UNWRAPPED on one line —
  a soft wrap mid-phrase silently defeats the test that pins them, which is how the first
  attempt at this failed.*
- **The promise may now follow a destination the USER moved — and only that (2026-07-30).**
  `refreshedOutcome` updated the human sentence on a user revision and never the
  assertions, so a revised destination left the machine-checkable half naming a place the
  workflow no longer used — and the assertions are what `UNSATISFIED_ASSERTION` is
  measured against, so a stale one does not merely read wrong, it **fails a correct
  workflow and buys rebuilds**. Exactly one edit is now admitted: the same promises about
  a different place. `onlyTheDestinationMoved` requires an identical COUNT and an
  identical `kind`+`when` multiset paired 1:1, which leaves `target` as the only field
  that CAN differ — so "only the destination moved" is guaranteed by construction rather
  than inspected. The `when` pairing is the one that would otherwise leak: an
  unconditional promise gaining `when: "urgent"` is promised on one lane only, which is
  weaker while reading as a rename. A moved target must still be checkable, so a
  `{{template}}` and a bare `connector:` are both refused. Pinned by the new block in
  `tests/converger/user-has-the-last-word.test.js` (26 total), **seven mutations
  red→green**. *NOTE: this was NOT the cause of the build above — that was the prompt
  defect, and no user revision happened. It is a real gap fixed on its own merits; do not
  file it as that build's root cause.*
- **THE PROMISE NAMED A SPREADSHEET THE PERSON HAD NEVER HEARD OF — FIXED
  (2026-07-30).** Witnessed on prod (`build-platform-1785419902877`) driving a
  Gmail→Sheets logger. The contract promised `record_exists → sheets:Pricing Emails`.
  The sheet the user named — when Atlas asked them, one turn later — was **Pricing
  Enquiries**. Nobody ever said "Pricing Emails": the `outcome` node invented it from
  the opening intent, *before* the destination question was asked. So the promise could
  not match the step built from their answer — `UNSATISFIED_ASSERTION`, **three paid
  whole-spec Opus passes** trying to fix a workflow that was already correct, then the
  rebuild gate refusing the fourth. The workflow could not go live, and the panel showed
  the user *"Adds a row to your spreadsheet (Pricing Emails)"*.
  **The mechanism, which is the general form of the two destination defects fixed
  earlier the same day:** assertions are written ONCE, from the opening intent, before
  any destination is settled; the answer then updates the STEP and nothing else, so the
  contract keeps its opening guess forever. `refreshedOutcome` does not cover it — that
  fires on a user REVISION, and **answering a question you were asked is not a
  revision.** Being asked is the commoner path of the two.
  **The fix moves the promise only onto a destination the person demonstrably typed**
  (`retargetStaleAssertion`, applied by `autoRepairStructural` as `set_assertion_target`
  — no question, no model call, no rebuild, exactly like `set_assertion_when`). BOTH
  must hold: the promise's current destination is NOT among their answers, and the
  step's destination IS. **Retargeting on the spec alone would destroy the promise
  system outright** — every workflow that failed its contract would rewrite the contract
  and pass — and that mutation is the first one in the test file. If the person named
  the destination only in their opening message and the model built a step elsewhere,
  neither side is in the corpus, nothing moves, and the build correctly fails.
  **The corpus is deliberately incomplete and every consumer must treat "not in here" as
  "no evidence", never as "they didn't say it".** Only answers to real questions count:
  entries whose question is parenthesised (`(setup: …)`, `(still missing)`, `(plan
  change)`, `(user modified …)`) are Atlas talking to itself, and `intent` is
  model-written — admitting either would let the machine corroborate its own guess,
  which is the laundering hop this file records on its third and fourth appearances.
  A destination buried in a sentence is **not** recognised, on purpose: substring
  matching against free prose would let a one-word destination match almost any answer.
  This also generalises the Slack-only assertion rewrite in `fillDestination`
  (`kind === 'slack_channel'`), which was the same idea scoped to one connector.
  Pinned by `tests/converger/the-promise-follows-the-answer.test.js` (20), **eight
  mutations red→green — four survived the first pass and the tests were strengthened
  rather than the mutations dropped**: the "they named it" guard, the kind test and the
  answer-splitting were all passing for the wrong reason (a second guard blocked the
  case anyway), and two further guards were proved *unreachable* and removed rather than
  left as untested code.
- **A PROMISE WRITTEN WITH THE VENDOR NAME WAS TREATED AS A PROMISE ABOUT GMAIL —
  FIXED (2026-07-30).** Witnessed on prod (`build-platform-1785424869443`) driving a
  demo-booking workflow (read the email → book a 30-minute hold → reply to confirm).
  The workflow was correct. The oracle said *"nothing reached "Calendar" in google —
  this run delivered to `{{compute_event.event_title}}` (calendar)"*, and it cost two
  whole-spec Opus passes before the rebuild gate refused the third.
  **`canonicalConnector('google')` returns `gmail`** — `google` sits in gmail's alias
  list — so at RUN TIME every promise written with the vendor name (`google:Calendar`,
  `google:My Report`) silently became a promise about Gmail, and every non-Gmail Google
  delivery was recorded as "delivered somewhere else". The BUILD half never had the bug
  because it asks with the raw name as well (`eff.connectors.has(connector) ||
  …has(canonicalConnector(connector))`); the runtime asked only canonically. **Eighth
  instance of the two halves drifting, and the third caused by one of them
  canonicalising when the other did not.** The runtime now asks both ways
  (`reaches`), which is the directed question it was always supposed to ask —
  `calendar` carries `google` among ITS aliases.
  **Second, smaller half, fixed in the same commit ON PURPOSE:** a locator that names
  the SERVICE while the assertion names the VENDOR (`google:Calendar`) is excused as
  adding no information, the same way `locatorIsJustTheConnector` already excused
  `calendar:Calendar`. Applied to BOTH halves together — putting it in one side only
  is exactly how `google_tasks` and then `google_drive` drifted. Pinned by
  `tests/workflows/a-promise-may-name-the-service.test.js` (18), **five mutations
  red→green — one survived the first pass**: the fixture used a TEMPLATE event title,
  which is excused by a different rule entirely, so the build-time half could be
  deleted with the suite still green; only a LITERAL title reaches the locator
  comparison, and that case was added rather than the mutation dropped.
- **THE DECLARATION WAS DEAD CODE FOR SIX CAPABILITIES — FIXED (2026-07-30).** While
  fixing the above I found that `CHANNEL_EFFECTS` — a hardcoded 13-entry table in
  `outcome-oracle.js` mapping a channel to its connector, kind and locator keys — is
  consulted **before** the capability's own declaration, in both `nodeEffect` branches.
  So for every capability appearing in both (`gmail_send`, `docs_create`,
  `sheets_append`, `calendar_create_event`, `airtable_create_record`,
  `airtable_update_record`) the declared `effect` / `assertionKind` / `locatorKeys` are
  **never read**. That is the ninth instance of one rule living in two places, and it
  hides in the worst way: the declaration audit asks *"is everything declared?"* and the
  agreement sweep asks *"do the two consumers agree?"*, and **both pass**, because
  neither asks whether the declaration is USED. `calendar_create_event` even carries a
  `locatorKeys: ['title']` declaration written to MATCH the table — they agreed, and
  were wrong together.
  **THE FIX IS ORDERED BY CONFIDENCE, NOT BY SOURCE**, and that distinction was found
  by a failing test rather than by reasoning:

      explicit declaration  >  CHANNEL_EFFECTS  >  inference from the id

  The first attempt was the blunt "declaration always wins", which broke the P13-0 seam
  test: a capability that is merely REGISTERED declares nothing, and P13-0's rule that
  silence from something delivery-capable counts as a WRITE is an INFERENCE whose kind
  comes from a verb regex that knows nothing about Slack. So `slack` — registered,
  undeclared — became a `record_exists`. The table is hand-written knowledge about a
  specific channel and must outrank that guess, while never outranking a capability
  that states its own effect, kind or destination (`declaresExplicitly`).
  **The blast radius was far smaller than it looked** — measured before changing
  anything: of the six ids in both, FOUR were byte-identical, and the two that differed
  (`docs_create`, `calendar_create_event`) differed only by a `subject` locator key that
  neither capability accepts. The four test failures that caused the first attempt to be
  reverted came from an unrelated change made in the same pass, not from the inversion.
  The table's entries are KEPT, not deleted: many checks build the oracle with no
  catalog, and removing them would silently drop those to the verb regex.
  **Fixed alongside, latent rather than witnessed:** `locatorKeys: []` read as
  "undeclared" and fell through to the GUESS list, so a capability with exactly ONE
  possible destination could not say so. Declaring no keys IS a declaration.
  **Pinned by `tests/workflows/the-declaration-is-reachable.test.js` (14) — THE THIRD
  QUESTION, which nothing was asking:** the audit asks *"is everything DECLARED?"*, the
  sweep asks *"do the two consumers AGREE?"*, and this asks *"is the declaration
  USED?"*. Both of the others passed throughout the defect's life, because nothing was
  missing and the two consumers agreed — on the table. Four mutations red→green; the
  `locatorKeys: []` one survived the first pass (nothing ships `[]` today) and a
  synthetic fixed-destination capability was added rather than the fix left untested.
  The table ids are recorded by HAND in that file rather than imported, because
  importing them would make the guard agree with whatever the table says.
- **EVERY BUILD NOW ASKS WHETHER IT AGREES WITH ITSELF (2026-07-30, Charles's call).**
  Almost every defect in the destination family has been two things Atlas already knew,
  disagreeing, with nothing comparing them — and every one was found by a person reading
  a screen carefully, days later, one at a time. `src/workflows/self-consistency.js`
  asks the whole question once, at the `walkthrough` node, of the finished build:
  do the build-time and run-time halves of the promise check agree; does the promise's
  own sentence name a destination no step uses; do the human half and the
  machine-checkable half of one promise name different places; is a promise checkable at
  all; does a step change the world with nothing promising it.
  **It REPORTS and never repairs, and never blocks** (`converger.self_check` in the
  log). Everything reaching that node is already valid and publishable; a general fixer
  would be a general way to make a build agree with itself by promising less, and repair
  belongs to the mechanisms that understand a specific case.
  **Validated by REPLAY against three real prod builds** rather than invented fixtures:
  it names the defect in the AI-news briefing (promise said `hello@`, only send went to
  `charles@`) and in the Sheets logger (promise named "Pricing Emails", user said
  "Pricing Enquiries"), and is **completely silent on the cybersecurity briefing that
  passed and went live** — which is the property that matters, because a check that
  fires on a good build teaches people to ignore it and an ignored check looks like
  cover.
  **PRECISION OVER RECALL, deliberately.** Only high-precision tokens are read from the
  sentence (an address, a #channel, a Quoted Name); free prose is not mined; templates,
  opaque provider ids and destinations nobody stated are silence, not findings.
  Pinned by `tests/workflows/does-this-build-agree-with-itself.test.js` (24), **eight
  mutations red→green**. Three defects in the check were found by mutation before it ever
  ran on prod, and all three were FALSE POSITIVES on correct workflows: the address
  matcher swallowed a sentence's full stop (so a promise differed from itself); an
  approval workflow reported its own approver as "a destination no step uses", because a
  `human` node sends its own DM and has no `nodeEffect` (now reuses the oracle's
  `humanAskTargets` rather than a second copy of that rule); and a run receipt was being
  synthesised from a `foreach` WRAPPER, which production never does — the children
  execute — manufacturing a "the two halves disagree" on a perfectly good loop. That
  last one is the "a check must construct its subject the way PRODUCTION does" rule
  catching the checker written to enforce it.
  **IT CRIED WOLF ON ITS SECOND DAY, AND THAT IS RECORDED HERE BECAUSE IT IS THE FAILURE
  MODE THAT MATTERS.** Driving shape 8 (a Slack-triggered workflow) on prod it reported
  *"The promise tells the customer this workflow delivers to "#atlas-test-temp", but no
  step in it does"* — about a completely correct workflow. The channel is where the
  workflow LISTENS; the only destination is the email. A place a workflow reads from is
  not a place it should be writing to, and `triggerValues` now excuses it. Caught by the
  check running live on a real build rather than by a person, which is the point of it,
  but a check that fires on a good build is worse than no check and this came one build
  from teaching everyone to ignore it. Pinned with that exact workflow as the fixture.
  **IT CRIED WOLF TWICE, BOTH TIMES FROM THE SAME CHECK, AND BOTH ARE RECORDED HERE.**
  (a) Shape 8, a Slack-TRIGGERED workflow: *"the promise names #atlas-test-temp but no
  step delivers there"* — the channel is where it LISTENS. Fixed by `triggerValues`.
  (b) Shape 9, an escalating approval: the sentence named `#atlas-test-temp`, which the
  SECOND promise covered exactly, and `PROMISE_AND_SENTENCE_DIFFER` compared it against
  the FIRST promise's locator. **That check now fires only when the pairing is
  unambiguous — one destination named, one promise** — because with two promises and one
  name there is nothing to pair and guessing is what produced the finding. Recall is
  deliberately sacrificed; the Sheets logger it was built for is exactly that shape and
  still fires, which is asserted in the same test.
  **Both were caught by the check running live on real builds rather than by a person,
  which is what it is for — including when the thing it catches is itself.** But a check
  that fires on a good build is worse than none, and two in two days on the same rule is
  why that rule is now the narrowest of the five.
  **One check is pinned only at SOURCE level and says so in the file:** `HALVES_DISAGREE`
  cannot be exercised behaviourally while the two halves agree on every capability,
  spelling and pairing (which `build-and-runtime-agree-everywhere.test.js` proves). It is
  a regression detector for the ninth instance of that drift; replace the source pin with
  a behavioural one if a legitimate disagreement ever becomes constructible.
- **ONE IDENTITY PER DESTINATION — the promise and the step now point at the same thing
  (2026-07-30, Charles's call: "build the complete fix").** A destination lives in three
  vocabularies at once — what the customer says ("my calendar", "Pricing Enquiries"),
  what the spec stores (`spreadsheetId: 1BxiMVs0…`), and what the promise states
  (`google:Calendar`) — and those were bridged by comparing STRINGS through alias
  tables, guess lists and canonicalisation in **more than thirty places**. Nine defects
  came out of that in two days, each costing paid Opus rebuilds and twice a workflow
  that could not go live. Fixing them one at a time never reduced the rate.
  **A workflow now carries a table of the destinations it uses.** Each entry is created
  once and given an id; the step that writes there and the promise about it carry that
  id, and `satisfiesAssertion` compares ids when both sides have one. Two things
  pointing at one entry cannot disagree about where they mean — not because a rule keeps
  them in step, but because there is only one of it. Built by `indexDestinations`, run
  as the last act of `mergeGeneratedSpec`, deterministic and model-free: it reads what
  the build already decided, never invents a destination, never moves one, never edits a
  locator.
  **ADDITIVE, AND THAT IS THE LOAD-BEARING PART.** The id is consulted only when BOTH
  sides have one; `sameDestination` returns **null**, not false, when either lacks it,
  and the caller falls through to the old string rules. So every spec ever stored
  behaves exactly as before, and a half-stamped spec cannot fail a workflow that
  publishes today. Returning `false` for the unknown case is mutation M1 and it turns
  seven tests red — every previous defect in this family came from a check answering a
  question it could not answer, and answering "no".
  **A STALE PROMISE IS LEFT UNSTAMPED ON PURPOSE.** Only a place a step actually writes
  becomes a destination; inventing an entry for a promise that matches nothing would give
  it an identity of its own and make it look settled, when "this names somewhere no step
  goes" is the finding that has to survive.
  **Three defects in the change, all caught by tests before it shipped, and two are
  instances of the very families this work exists to end:** the ids were first put inside
  `node.config`, where an undeclared key is a hard publish failure
  (`UNKNOWN_CONFIG_KEY`) — it made **every workflow in the product unpublishable** and
  the full suite caught it; the destination's service was taken from `eff.connectors`,
  an alias SET beginning with the vendor, so a Google Sheets row was indexed as
  `gmail::leads` — **the same `google → gmail` trap fixed in the runtime hours earlier**,
  now solved by deriving the service from the capability id; and the cell `range` was
  indexed as a place a workflow writes, which is wrong for stage 3 where each entry is
  resolved against the real service. Pinned by
  `tests/workflows/one-identity-per-destination.test.js` (19), eight mutations red→green.
- **A PER-ITEM WORKFLOW COULD NOT PROVE ITSELF, BECAUSE ITS TEST HAD NO ITEMS — FIXED
  (2026-07-30; the most expensive defect of the ten-shape campaign).** Shape 4 — "every
  Monday, summarise each unread email from the past week into a row in a sheet" — cost
  **FIVE paid whole-spec Opus passes and ~7 minutes of generation**, then the rebuild
  gate refused a sixth, and it still could not be cleared to go live. The workflow was
  CORRECT: schedule → search Gmail → `foreach` over the results → summarise → append a
  row. Verified from the stored spec: the promise `sheets:Weekly Inbox Digest` and the
  `append_row` step INSIDE the loop both carry destination `d1`.
  **The dry run said *"nothing reached "Weekly Inbox Digest" in Google Sheets — no step
  in this run attempted it"*, twice** — because the loop iterated over
  `search_emails.output`, which in a dry run is EMPTY. Zero items, so the write never
  runs, so the promise about what happens per item is scored BROKEN rather than NOT
  EXERCISED. **That is the same shape as the quiet-path defect fixed 2026-07-29** — a
  path that legitimately does nothing being called a broken promise — reappearing
  through the `foreach` door. Two of the five passes were `verify_failed` rebuilding a
  spec that was already right.
  **A second, independent cause in the same build: the sufficiency critic cannot see
  inside a loop.** It ordered a rebuild for *"An AI step to generate a one-line summary
  for each email"* — a step the spec already had, inside the `foreach`. On the later
  pass `sufficiency_overruled` correctly discarded the same complaint, so the guard
  works; the critic's blindness to loop contents is what generated it.
  **Third, cheap but real:** one pass was lost to `UNKNOWN_CONFIG_KEY: append_row` — the
  model invented a config key. Correctly refused; still a paid rebuild.
  **THE FIX.** `emptyLoopEvidence` gives the third verdict its due: a promise about
  per-item work, on a run whose collection was empty, is **not exercised** rather than
  broken. It sits in exactly the position `approvalAskEvidence` already occupies —
  consulted strictly AFTER the delivery check has said no — so a real delivery always
  wins and this can never mask one. Moving it BEFORE that check makes a kept promise read
  as skipped, and that is mutation M6.
  **FOUR NARROWINGS, because "not exercised" is one word from "we stopped checking"**, and
  a blanket version would launder every missing delivery in any workflow containing a
  loop. Each is a way the loop could LOOK empty without the promise being unexercisable:
  every step that could keep the promise must be inside a loop (a top-level write that
  did not deliver is a real miss); the loop must have ACTUALLY RUN (absent means
  something upstream failed — a broken run, not an empty one); the collection must have
  been genuinely empty, read from `total` **specifically and never falling back to
  `count`** (a loop reporting how many it PROCESSED but not how many there WERE has not
  said the collection was empty, and "I don't know" must fail closed — found by a test,
  not by reasoning); and nothing may have been SKIPPED or TRUNCATED (hitting the per-run
  item cap is a real event and must never read as "there was nothing").
  Pinned by `tests/workflows/nothing-to-do-is-not-a-broken-promise.test.js` (13), six
  mutations red→green.
  **STILL OPEN, and it is the other half:** the example machinery cannot give a `foreach`
  a NON-empty collection to run over, so a per-item workflow is now honestly reported as
  unproven rather than wrongly failed — but it still cannot be positively certified. The
  two other causes found in that same build also stand: the **sufficiency critic cannot
  see inside a loop** (it ordered a rebuild for a step the spec already had, nested in the
  `foreach`), and one pass was lost to the model inventing a config key
  (`UNKNOWN_CONFIG_KEY: append_row`).
- **Jargon is still reaching customer-facing cards from the MODEL, not the renderer
  (open, 2026-07-30).** Two witnessed the same session: a plan's failure line reading
  *"the **foreach loop** runs over an empty list"*, and a trigger card rendering a
  complex Gmail query as *"mentioning "(subject:(buy)", mentioning "OR", mentioning
  "buying"…"*. The first is the model writing code words into prose the plain-English
  work never touches (that work fixed RENDERERS); the second is `_plainFilter` meeting a
  query with parentheses and `OR` groups, which it splits on whitespace and describes
  fragment by fragment. The trigger card is the FIRST card in the walkthrough, so it is
  squarely in the demo path.
- **ATLAS PROMISED TO USE KNOWLEDGE DOCUMENTS THAT DO NOT EXIST (open, found 2026-07-30 — the most serious truthfulness defect of the ten-shape
  campaign).** Asked for a support-reply workflow grounded in company documents, Atlas
  asked the right question — *"Where does your knowledge base live? A Google Doc, a
  folder of Docs, a Sheet, a website…"* — and, told "I uploaded them to Atlas under
  Knowledge in the sidebar", answered:
  > **"Perfect — I can pull from your Knowledge docs in the workflow."**
  **That is false twice over, and neither half was checked before it was said:**
  1. **There are no documents.** The tenant's Knowledge section is empty — verified in
     the browser (no folders, no files) and on the box (no `memory/rag/sources.json`, no
     `memory/rag/` contents at all).
  2. ~~**A browser-uploaded document can NEVER be read by a workflow.**~~ **THIS WAS
     WRONG AND IS CORRECTED HERE (same day).** `POST /rag/upload` PERSISTS uploaded files
     and records the ABSOLUTE folder path, explicitly "so filesystem_read/list can reach
     it and the converger treats it as a filesystem folder". A document upload IS
     readable by a workflow; only an image-only upload (nothing persisted) is not. The
     claim came from `filesystem.js`'s own header and this file's P8 note, **both of
     which were stale** — corrected in the same commit. The lesson is the one this file
     already states: a doc that disagrees with `main` is confidently wrong and reads as
     authoritative. It was asserted to the operator twice before being checked against
     the upload handler.
  **Why this is the worst kind:** it is a confident claim about the product's own
  capability AND about the customer's data, made without consulting either, at the exact
  moment a person decides to trust it. The workflow that follows would ground on nothing.
  It is the same family as "Atlas told a user their CONNECTED connector wasn't connected"
  (2026-07-29) inverted — there it denied a capability it had; here it claims one it does
  not.
  **A third, smaller finding in the same exchange:** the list of places a knowledge base
  can live does not include Atlas's OWN Knowledge section, so a customer who has put
  documents there is not pointed at them; they have to volunteer it, as was done here.
  **Not fixed.** The shape of the fix is the connector-availability one: the builder
  already receives `capabilities`, and whether this tenant has any workflow-readable
  knowledge source is a fact available at build time. Silence about an empty knowledge
  base is not neutral — it reads as confirmation.
- **EVERY SLACK-TRIGGERED WORKFLOW IN PRODUCTION IS DEAD — IT NO LONGER PUBLISHES AS LIVE (half-fixed 2026-08-01;
  witnessed 2026-07-30 — this is the live confirmation that has been pending since
  2026-07-24, and it is NEGATIVE).** A Slack-triggered workflow was built, tested
  ("Contract kept"), published, and fired for real: the Atlas bot is in
  `#atlas-test-temp` (`"Atlas APP joined #atlas-test-temp. Also, charles joined."`), a
  human posted a message containing the keyword, and **nothing happened** — no run, no
  email, no log line.
  **The cause is upstream of every line of trigger code.** Measured on the box: across
  the ENTIRE event-log history the only Slack paths ever hit are
  `/connectors/slack/status` (54), `/callback` (1) and `/authorize` (1). Slack has
  **never delivered a single event to Atlas.** The endpoint itself is fine — probed from
  the public internet, `POST /connectors/slack/events` answers the `url_verification`
  handshake correctly (HTTP 200, echoes the challenge). So the gap is in the **Slack app
  configuration**: Event Subscriptions is not enabled, or its Request URL is not
  `https://atlas.agntic.co/connectors/slack/events`, or `message.channels` is not among
  the subscribed bot events. That is a console setting only the operator can change.
  **THE PRODUCT DEFECT IS THAT IT PUBLISHED ANYWAY.** The fail-closed publishing rule of
  2026-07-24 — "a workflow that saves, shows as live, and can never fire is the lie the
  product exists to prevent" — checks that AIRTABLE triggers can be armed and has no
  equivalent for Slack. Nothing asks whether Slack will actually deliver. So this is the
  same silent failure that rule was written for, arriving through a door it does not
  cover, and it is the third instance of that shape in this file.
  **THE PRODUCT HALF IS NOW FIXED (2026-08-01).**
  `src/connectors/slack/delivery-record.js` gives Slack the equivalent of Airtable's
  `checkAirtableTriggersArmable` — same `{ok, code, error}` shape, same plain-language
  sentence — applied at **BOTH** publish paths (POST and the PUT that is the real publish
  path for most workflows). The events route records every `event_callback` first, before
  dispatch, because an event matching no workflow still proves the plumbing works; the
  `url_verification` handshake returns before anything is recorded, so a probe cannot
  masquerade as a delivery (mutation M7).
  **THE REFUSAL IS SCOPED TO THE ONE UNAMBIGUOUS STATE, and this is the whole design.**
  The obvious rule — *"refuse unless we have seen an event for THIS tenant"* — traps every
  correctly-configured workspace at its FIRST Slack workflow, because no event can arrive
  before one is published. So: **never received an event from anyone, ever** ⇒ Event
  Subscriptions is not delivering here ⇒ refuse, naming what to change. **Received events,
  but none yet for this tenant** ⇒ the deployment is wired and this workspace may simply be
  quiet, or the bot may not be in the channel ⇒ ALLOW. "Not yet" and "never" are different
  answers. That trapping mutation is M2 and it is the one that matters most.
  Pinned by `tests/api/slack-trigger-must-be-able-to-fire.test.js` (18), **seven mutations
  red→green — one survived the first pass and the test was strengthened rather than the
  mutation dropped**: dropping the `type === 'event'` check was invisible because every
  case that could have caught it also lacked a `connector`, so the LEGACY
  `connector_event` shape (eight stored workflows carry it) was added as the case that
  distinguishes them — it is refused earlier and more accurately by `TRIGGER_NOT_RUNNABLE`,
  and claiming it here would answer with a Slack sentence that is not the user's problem.
  **A SECOND, INDEPENDENT REASON THE SAME WORKFLOW COULD NEVER FIRE — FIXED
  (2026-08-01), and it would have made the console fix look like a failure.** The Slack
  workspace `T0B3RTT3Z5X` is installed on **BOTH** `agntic` (11 July) and `platform`
  (26 July). Tenant resolution was `SELECT tenant_id … WHERE connector_id=? AND account=?
  **LIMIT 1**`, which returns `agntic`. The only live Slack-triggered workflow lives in
  **`platform`**. So even with Slack delivering perfectly, every event would have been
  matched against the wrong tenant's workflows, found nothing, and returned silently.
  **`LIMIT 1` on a key that legitimately has several rows** is the arbitrary-answer shape
  this file records over and over. `findTenantsByAccount` (plural) now returns EVERY
  tenant that installed the account, in install order, deduplicated — a re-install writes
  a second row and would otherwise have dispatched every event twice, which for a workflow
  that sends email is a duplicate message to a real person.
  **Dispatching to all of them is not a leak:** each of those tenants ran the OAuth flow
  and authorised the app, so the event is genuinely theirs, and each is dispatched against
  its OWN workflows with its OWN token.
  **The approval BUTTON path had the identical defect** — a click on a run owned by the
  other tenant resolved to the wrong one and silently found nothing. It now asks each
  candidate and keeps the first ANSWER rather than the first attempt.
  Pinned by `tests/api/one-workspace-many-tenants.test.js` (10), six mutations, **five
  killed**. The sixth is honestly unkillable and is recorded as such rather than contrived
  into a kill: the early return on a blank account is belt-and-braces over a query that
  already cannot match (`account = NULL` is never true in SQL). A seventh needed the
  fixture rebuilt twice — dropping the `ORDER BY` survived because `GROUP BY` returns
  tenants alphabetically and `agntic` < `platform` happened to match install order, so a
  workspace whose alphabetical and install orders DISAGREE had to be added before the sort
  was observable at all.
  **THE OPERATOR HAS CONFIRMED (2026-08-01) that Event Subscriptions is on, all bot and
  workspace event scopes are enabled, and the Request URL is correct.** That is not
  reconcilable with zero inbound requests, and the remaining candidates are: Slack having
  DISABLED delivery after past failures against an earlier address (it does this and shows
  a banner), or the app whose subscriptions are configured not being the app installed to
  the workspace. **Do not assert a cause — measure.** The next real event settles it, and
  both known code-side blockers are now removed so the next test is clean.

  **STILL CHARLES'S TO DO, AND THE ONLY THING THAT MAKES SLACK TRIGGERS WORK:** enable
  Event Subscriptions in the Slack app, point the Request URL at
  `https://atlas.agntic.co/connectors/slack/events`, and subscribe to `message.channels`.
  Until then the product now refuses the publish honestly instead of showing a green tick;
  it does not make the trigger fire.
- **THE PROMPT OFFERED TWO TRIGGERS NO CONSUMER COULD HONOUR — FIXED, AND NOW ENFORCED
  (2026-07-30). The third instance of the `connector_event` defect, and the first time
  anything stops a fourth.** Asked for a contact form that POSTs to a URL
  to start a workflow, Atlas answered:
  > *"your form POSTs to a webhook URL that **Atlas generates when the workflow is
  > built**. That URL becomes the trigger — whenever the form fires, the workflow
  > catches the payload and emails the enquiry…"*
  …and went on to ask two detail questions as though the mechanism were settled. **No
  part of that exists.**
  **Ground truth, measured:** `RUNNABLE_TRIGGER_TYPES` is `email · schedule · manual ·
  event`; the registered trigger capabilities are exactly `gmail_new_message`,
  `airtable_record_changed`, `slack_message`, `slack_mention`; and the only inbound
  webhook routes are Stripe billing and the connector-specific ones. There is no URL
  generation and no route.
  **Where the belief comes from — `src/converger/prompts.js`, three places:** line 247
  describes `webhook: 'Fires when an HTTP POST is received at a generated endpoint'`;
  line 318 actively routes intent (*"Intent mentions webhook/HTTP POST/external call/API
  call → webhook trigger"*); and line 608 is a worked EXAMPLE emitting
  `{"type":"webhook","path":"/hooks/my-workflow"}`. So the interview is asking the model
  for a value the runtime cannot honour — **exactly the sentence written about
  `connector_event`**, whose entry ends: *"Keep the runnable set in step with the
  consumers; this check failing a publish is the signal that someone added one without
  the other."*
  **The guard would hold** — `TRIGGER_NOT_RUNNABLE` refuses this at publish. But the
  refusal comes after the whole conversation, and the FIRST sentence already promised a
  mechanism that cannot exist. Same family as "a connector's availability is only
  checked at BUILD time": the user does everything asked and then hits a wall.
  **AND `one_time` WAS THE SAME, WORSE, AND NOBODY HAD NOTICED.** Found while fixing the
  above: `one_time` is also absent from `RUNNABLE_TRIGGER_TYPES`, appears nowhere in
  `src/` outside the prompt, and is refused at publish — while **"do this now" and "run
  this once" are among the most natural things a person asks for**, and the prompt routed
  them straight at it. It sat in TWO copies of the trigger-inference table (lines ~318
  and ~678), which is the one-rule-in-two-places shape on top of the unrunnable-type one.
  Both intents now route to `manual`, which does exactly what they mean and can publish.
  **Removed:** both types from the trigger list, both intent-routing rules in BOTH tables,
  both worked examples, and both from the contentless-trigger list. **KEPT: `webhook` as a
  DELIVERY channel** — posting to a URL is real; what was removed is webhook as a way to
  START a workflow. Deleting both would have been an over-correction, and that is
  mutation M4.
  **THE DURABLE PART is `tests/converger/the-prompt-offers-only-runnable-triggers.test.js`
  (8), which scrapes every trigger type the prompt names and fails if it is not in
  `RUNNABLE_TRIGGER_TYPES`.** A prompt is a belief about model behaviour and is pinned by
  nothing; this is what makes being wrong about it cheap. The `connector_event` entry
  above closes with *"Keep the runnable set in step with the consumers"* — **it happened
  twice more because nothing enforced that sentence.** Four mutations red→green:
  re-adding a webhook example (3 red), re-adding `one_time` (2), re-adding
  `connector_event` (2), and deleting the webhook delivery channel (1).
- **ATLAS CONFIRMS AND ELABORATES CAPABILITIES IT DOES NOT HAVE — the pattern behind
  shapes 7 AND 10 (open, 2026-07-30).** Twice in one campaign, asked for something the
  product cannot do, Atlas did not check and did not refuse: it agreed, then explained
  the mechanism in confident detail. *"Perfect — I can pull from your Knowledge docs in
  the workflow"* (there are none — the mechanism is real, the DOCUMENTS are not); *"a
  webhook URL that Atlas generates when the workflow is built"* (no such thing exists).
  **This is the most demo-dangerous behaviour found**, because it happens at the FIRST
  turn, in the most confident register, before the plan, the promise, the self-check or
  the publish guard get a chance to act. Every one of those mechanisms is downstream of
  a claim that has already been made. The product's whole thesis is that it does not lie
  about what it did; this is lying about what it CAN DO, which no existing guard covers.
- **THE MODEL WAS NEVER TOLD THE NAMES OF THE TRIGGER TYPES — FIXED (2026-07-30).**
  Found while starting the registry-driven-prompt work Charles asked for, and it explains
  the two defects fixed hours earlier. `triggerSummary` rendered `capabilities.triggers`
  as if it were a map of trigger TYPES. It is the **ARRAY** of registered trigger
  CAPABILITIES (`gmail_new_message`, `slack_message`, …) that `builder.js` builds from
  `capabilityRegistry.list({position:'trigger'})`, and `Object.entries` over an array
  yields its INDICES. Measured against the real registry, the prompt read:
      TRIGGER TYPES:
      - 0: Fires when a new Gmail message arrives…
      - 1: Fires when a message is posted to a Slack channel.
  **The words `email`, `schedule`, `manual` and `event` never appeared in the section
  that names them**, and because that array is never empty in production the correct
  hand-written fallback beneath it was UNREACHABLE. The model could only learn a type
  name from the intent-inference tables and the worked examples — **which is exactly how
  `webhook` and `one_time` became real to it**, and why deleting them mattered more than
  it looked.
  Now keyed by `RUNNABLE_TRIGGER_TYPES` itself, so the list cannot name a type nothing
  can start nor omit one that works, and the registered trigger CAPABILITIES are rendered
  separately by the block that reads the array AS an array (that block was always
  correct — an `undefined` seen while investigating was a bad test fixture of mine, not a
  defect; checked before reporting).
  Pinned by `tests/converger/the-prompt-offers-only-runnable-triggers.test.js` (13),
  **three mutations red→green — one survived the first pass**: an extra entry in the
  description map renders nothing, so it is harmless as output, but it would READ as
  support for a type that can never fire, so keys are now asserted equal to the runnable
  set rather than the mutation being dropped.
  **THE GENERAL LESSON, and it is the one Charles named:** the failures cluster where the
  agent's picture of its own tools is wrong. Here the derived path existed and was
  BROKEN, while the hand-written fallback was correct and unreachable — so "derive it
  from the registry" is necessary but not sufficient; the derivation has to be *checked*,
  or it fails silently and hand-written examples quietly become the real source of truth.
- **THREE CONNECTED SERVICES WERE LISTED AS HAVING NO CAPABILITIES — FIXED (2026-07-30,
  the registry-driven-prompt work Charles asked for).** The per-connector capability list
  read `c.actions` off the connection-STATUS objects in `capabilities.connectors`, and
  **only Google carries one** (from `resolveGoogleCapabilities`). Measured against the
  production shape, the prompt read:
      SLACK:
      GOOGLE: gmail_search, sheets_read
      AIRTABLE:
      WEB:
  Three connected services listed with nothing after the colon — **worse than omitting
  them**, because a blank list is a claim, and the claim is "this service can do
  nothing". Airtable's nine step capabilities and Web's two were invisible to the model
  while being fully registered and runnable.
  Now derived from the CHANNEL CATALOG — the same registry-built list the delivery block
  already used correctly — which carries every capability's `connector`, so the grouping
  is exact. A connected service that contributes no STEP capabilities (Slack, whose
  registrations are triggers) says so **in words**. Google now offers 15 and Airtable 9.
  Pinned by `tests/converger/the-agent-is-told-what-it-can-do.test.js` (9), four
  mutations red→green; restoring the production bug turns FIVE red.
  **THE METHOD THAT FOUND IT, and it is the transferable part:** every test in that file
  builds the ACTUAL registry and passes the ACTUAL catalog. Both defects in this pass
  were invisible to a fixture shaped the way the author imagined — and in BOTH a derived
  path already existed and was silently producing garbage while a correct hand-written
  fallback sat underneath, unreachable. **"Derive it from the registry" is necessary but
  not sufficient: the derivation must be checked against real objects, or hand-written
  examples elsewhere quietly become the real source of truth.** That is how `webhook` and
  `one_time` became real to the model.
  **Checked and deliberately NOT changed:** the DELIVERY catalogue was already
  registry-driven and rendering correctly (names, descriptions, config fields, output
  formats). It is now pinned so work on its neighbours cannot break it.
- **KNOWLEDGE IS NOW A REGISTERED CONNECTOR — readable, writable, and usable in a
  workflow (2026-07-30, Charles's call).** *"We are not exposing the tools that are
  available to the agent, to the agent properly… Knowledge should be writeable, readable,
  and contents able to be used in workflows."* Measured that day, the product had a
  Knowledge page, a per-tenant RAG index and **zero registered capabilities**
  (`knowledge/rag capabilities: (NONE)`), and the cost was a truthfulness defect, not an
  inconvenience — see the shape-7 finding above.
  `src/connectors/knowledge/index.js` registers **`knowledge_search`** (read) and
  **`knowledge_write`** (write, `document_exists`). Registered rather than special-cased
  so everything that reads the catalog gets it for free: the interview, the destination
  oracle, the write/approval guards, the declaration audit, the plain-English step words.
  **Both halves of the honesty fix shipped together**, because the capability alone would
  not have stopped the false claim: `capabilities.knowledge` now carries the document
  count, and the interview is TOLD when it is zero — *"this workspace has NO documents in
  Knowledge yet… do not offer to use your knowledge base, whatever the user believes they
  uploaded"*. Silence about an empty base is what read as confirmation.
  **THREE DEFECTS IN MY OWN WORK, ALL CAUGHT BEFORE SHIPPING, ALL FAMILIES THIS FILE
  ALREADY NAMES:**
  · **`isReady` is NOT per-tenant.** The registry calls it with NO arguments — a
    deployment-level question. My first version asked "does this tenant have documents",
    which resolved to `readSources(undefined)` → `[]` → **permanently unavailable for
    everyone**. Measured: a tenant holding a document still got `available:false`.
    Registering a capability nobody can ever use would have been a quieter version of the
    defect it exists to fix. Per-tenant emptiness travels `capabilities.knowledge`.
  · **The tenant injector stamped only one node shape.** `knowledge_write` can occupy a
    DELIVERY position, where the capability id is `config.channel`, not `config.action` —
    so that node would never be stamped and the capability (correctly) refuses to run
    without a tenant. The "added to the top-level executor, not the sub-loop" shape.
  · **The declaration audit had no category for a FIXED destination.** It demanded
    non-empty `locatorKeys` of every write, and Knowledge has exactly one destination.
    Taught the third shape — `locatorKeys: []` **plus** a `defaultLocator` — and held it
    to its bargain with a new test, rather than weakening the rule.
  **Isolation is fail-closed:** RAG is physically isolated per tenant, and both handlers
  REFUSE to run with no tenant in scope rather than searching unscoped. That is mutation
  M1. Pinned by `tests/connectors/knowledge-is-a-real-capability.test.js` (23), six
  mutations red→green.
  **NOT a trigger, deliberately** (the required per-connector answer): nothing happens
  "when a document changes" — a workflow reads Knowledge when it runs. No subscription to
  register, renew, verify or tear down, and no public-reachability requirement, so unlike
  Slack it is fully provable on a laptop.
- **THE INBOX WAS ALREADY READ+WRITE — WHAT WAS MISSING WAS THE DECLARATION (2026-07-30).**
  Charles asked for "the inbox should also be read and writable"; checking first showed it
  **already is**: `src/inbox/index.js` registers `inbox_deliver` (delivery) and
  `search_inbox` (step, semantic search over past deliveries), both wired at boot.
  **An earlier measurement of mine reporting `inbox capabilities: (NONE)` was wrong** — my
  probe never called the inbox registrar. Corrected before building anything.
  **What WAS wrong: both shipped declaring nothing.** No `effect`, no `assertionKind`, no
  `locatorKeys`. So `inbox_deliver` fell through to the hardcoded channel table, which
  lists `locatorKeys: ['subject','title']` — **the oracle believed the step wrote to its
  own SUBJECT LINE.** Measured: a node with `subject: "Weekly digest for {{today}}"`
  reported that template as its destination. **Third instance of title-as-destination**
  (Google Tasks, Calendar, this). No promise failed, because the inbox is exempt from
  locator comparison (`LOCATOR_FREE_CONNECTORS`) — but it is what a PERSON reads in the
  failure sentence: *"this run delivered to Weekly digest for {{today}}"*. The exemption
  was masking it, which is why nobody had seen it.
  Now declared: `inbox_deliver` is `write` / `message_sent` with a FIXED destination
  (`locatorKeys: []` + `defaultLocator: 'your Atlas inbox'` — the subject is CONTENT), and
  `search_inbox` is `read`. Both now face the declaration audit. Four mutations red→green.
  **Two things found and handled while doing it:**
  · **`search_inbox` is the one capability named `<verb>_<noun>`** rather than
    `<connector>_<verb>`, so its id prefix is "search". The audit's prefix rule is now
    scoped to WRITES — faithful to the rule's own reason, since assertion targets come
    from the prefix and a read produces no assertion. **Residual: renaming it to
    `inbox_search` would be tidier; stored specs carry capability ids, so it is not worth
    breaking them for consistency alone.**
  · **Canonicalising the prompt's connector grouping was tried and REVERTED.** Grouping by
    `canonicalConnector` to turn the inbox's internal `connector: 'atlas'` into a friendlier
    "INBOX" heading also sent every GOOGLE capability to `gmail` — all fifteen vanished
    under a Gmail heading and GOOGLE rendered as "contributes no workflow steps". **The
    google→gmail trap for the third time in one day.** `canonicalConnector` answers "do
    these name the same DESTINATION"; it is not a display-name function. An "ATLAS"
    heading is mildly odd, the regression was not.
- **ASKING A PERSON IS NOW A TOOL WITH RULES (2026-07-30, Charles's third ask —
  INCREMENT 1 of "the conversation as a tool").** *"The agent/converger/system should see
  the conversation as a tool to fill gaps the user could fill with information."*
  `src/converger/asking.js` applies four rules before any question reaches a person, and
  each REFUSES rather than rewords, because a question that should not be asked cannot be
  fixed by phrasing:
  1. **Never ask for a machine identifier.** The rule with no exception. Prod, same day:
     *"What is the spreadsheet ID for 'Pricing Enquiries'? You can find it in the URL of
     the sheet, between /d/ and /edit."* — after offering "ID **or name**" and being given
     a name. A customer sent to dig an id out of a URL is the developer-settings errand
     P13 forbids, wearing a chat bubble.
  2. **Never ask what was never looked up.** The Slack and Airtable destination questions
     have always been good, and the reason is that they arrive carrying `options` the
     connector was actually queried for. Sheets had no discovery wired and the same code
     path produced an errand. **The difference was never the wording.**
  3. **Never ask the same thing twice.**
  4. **A budget of three per build** — a CEILING, not a target. Applied LAST so a question
     refused for a better reason reports that reason (mutation M5).
  **A refused question is not a dropped requirement.** The build continues with what the
  person already said — for the Sheets case, the NAME they gave, which is what they know —
  and a destination that cannot be resolved then fails honestly at test time. That is the
  product's own promise (publish having answered nothing) rather than an errand.
  Wired into the `analyze` node's clarification path, where the errand was produced: the
  model PROPOSES a question, `shouldAsk` decides, and a refusal is logged as
  `converger.question_refused` rather than silently dropped. The prior-question count
  reads only the PERSON's answers — `clarifications` entries with a parenthesised question
  are Atlas talking to itself, and counting them would spend the budget on bookkeeping
  (mutation M7).
  Pinned by `tests/converger/asking-is-a-tool-with-rules.test.js` (24), seven mutations
  red→green. **The wiring assertions are SOURCE-level and say so** — the clarification
  site closes over the LLM and graph state and cannot be lifted; replace them if that node
  is ever made extractable.
  **WHAT REMAINS OF THIS PIECE, and it is most of it:** the model still cannot INVOKE
  asking as a tool at a moment of its choosing — the graph still asks where the graph
  arrives. This increment governs whether a question is allowed, not when it is raised.
  The open items it does not yet fix are the ones about TIMING: destinations settled after
  the plan, connector availability checked only at build time. Rule 2 was also only as good
  as the discovery behind it — for Sheets there was none to attempt, so a legitimate
  question was refused with nothing to put in its place. **That was the next increment
  and it is DONE (2026-07-31, see the Sheets picker entry below); the TIMING half is
  what remains.**
- **TWELVE BUILDS, MEASURED: THE REBUILD RATE FELL FROM 2.5 PAID PASSES TO 1.11
  (2026-08-01).** Driven end to end as the fresh tenant through the real API — the same
  endpoints the browser uses — across twelve genuine small-business processes (email
  triage, daily digest, spreadsheet logging, approval-before-send, web research briefing,
  calendar booking, weekly doc report, urgent escalation, inbox delivery, multi-destination).
  · **12 attempted · 9 reached a finished workflow · 0 verify-failed rebuilds · mean 1.33
    paid passes.**
  · **BEFORE the sufficiency fix: 2 and 3 passes (mean 2.5). AFTER it: eight of nine
    builds took EXACTLY ONE pass** (mean 1.11). That is the ideal the whole rebuild-gate
    family has been chasing since 2026-07-29, reached and measured rather than asserted.
  · The three that did not finish **were not failures** — each paused correctly on a
    CLARIFICATION (at `destinations`, at `generate`) and my driver can only approve plans,
    not answer questions. Stated plainly because the raw number would otherwise read as a
    25% failure rate, and it is not one. It *is* a real measurement of something else: a
    quarter of these processes needed one more human turn.
  · Auto-repairs fired 5 times with no rebuild: `CONDITIONAL_UNSTATED` ×3 (the fix from
    this morning) and `CONDITIONAL_MISSTATED` ×2. Self-check: 8 consistent, 1 finding.
- **`HALVES_DISAGREE` HAS FIRED ON A REAL BUILD FOR THE FIRST TIME (open, 2026-08-01).**
  The calendar-booking build: *"The check that clears this workflow to go live and the
  check that reads a real run disagree about `google_calendar:primary` and the step
  'Create calendar event': one says the promise is kept, the other says it is broken."*
  **This is the tenth instance of the build-vs-runtime drift family, and the first one
  caught by the mechanism built for it rather than by a person reading a screen days
  later.** DIAGNOSED AND FIXED the same day — and it was TWO defects, one hiding the other.
  · **`calendar_create_event` declared `locatorKeys: ['title']`** — the event's own NAME
    read as the place it was written. The FOURTH instance of title-as-destination after
    Google Tasks, the Atlas inbox and this capability's own row in the old hardcoded
    table. **It had already been NOTICED** (2026-07-30: *"it even carries a `locatorKeys:
    ['title']` declaration written to MATCH the table — they agreed, and were wrong
    together"*): the precedence was fixed so the declaration is READ, and the wrong
    declaration was left in place. Reading a wrong declaration instead of a wrong table is
    still reading the wrong thing. The capability declares no `calendarId` and can only
    write to the account default, so it is a FIXED destination — `locatorKeys: []` plus
    `defaultLocator: 'primary'`, the shape Knowledge and the inbox already use, with the
    provider's own name for its default exactly as the Tasks fix used "My Tasks".
  · **`normalizeDelivery` still let the TABLE beat the declaration.** The 2026-07-30 entry
    says *"Both now read the one declaration."* **It was half true.** Only `nodeEffect`
    was corrected; in the receipt the declaration sat behind `if (!eff)`, so for the SIX
    ids present in both the table and the catalog the table still won — and the receipt is
    the half `checkAssertionAtRuntime` matches. **The second time a fix in this family
    reached one of two places.** Both now genuinely read it, via `nodeEffect` so the
    precedence is decided once rather than re-derived.
  **Order is load-bearing and was got wrong first:** the declared locator was pushed ahead
  of what the RUN reported, which broke *"a real run can correct the declaration"* — the
  only way a wrong declaration is ever caught. Run-reported first, declared second.
  **THREE TESTS ASSERTED THE DEFECT AND WERE RE-POINTED, NOT WEAKENED.** One expected
  `calendar:Standup` — the event's title — to be a kept promise; one guarded against
  fail-open using that same title, in a file whose comment eleven lines above warns that
  *"making it decide WHERE the event went is the defect family this repo has paid for
  three times"* (one test stated the principle, the next contradicted it); and the
  declaration audit knew only two of the three declared shapes, so an honest fixed
  destination failed it. Each keeps the property it existed for, against the right
  destination. Three mutations red→green — and **the agreement sweep CANNOT catch the
  wrong declaration**, only the drift, because with `title` on both sides the two halves
  agree while both being wrong. That is why the destination tests exist separately.

- **THE SUFFICIENCY CRITIC BOUGHT REBUILDS FOR COMPLAINTS THE SPEC COULD ANSWER — FIXED
  (2026-08-01).** Measured by driving two workflows as a new customer on a fresh tenant:
  **the critic ordered 3 of the 5 total rebuild passes across both builds**, and two of
  the three were answerable from the spec itself.
  · *"the branch must route on `classify_inquiry` output with cases for
    'pricing_inquiry' (to `compose_summary`) and 'none' (to `stop_no_action`)"* — the
    branch did **exactly that already**, and the walkthrough card listed those very cases.
    On the NEXT round the same complaint was correctly discarded as already-covered, so
    the product already knew — one paid pass too late.
  · *"the workflow lacks the actual connector-action configs for `search_inbox` and
    `search_sent`"* — **`search_sent` is not a capability.** No rebuild could ever add it;
    that pass was unwinnable before it started.
  **Both are the same failure: the critic asserted something about the spec that the spec
  itself can answer, and nobody asked the spec.** `sufficiency-actionable.js` asks two
  mechanical questions — does everything it names already exist, and does it name
  something that exists nowhere (not in the spec, not in the catalog). Either way the
  rebuild is refused and logged. This extends the existing *"an unverified opinion may not
  overrule a passing check"* rule from destinations (`sufficiencyClaimAlreadyCovered`,
  which reads assertion locators only) to the structure the complaint actually talks about.
  **IT FAILS TOWARD SPENDING THE PASS.** A complaint naming nothing checkable — the third
  of the three, *"a step that extracts individual email metadata"*, which may well have
  been right — is untouched. Discarding a real gap ships a deficient workflow; an
  unnecessary pass costs time and money, and the first is worse.
  **The identifier class is `snake_case`, and the spec is scanned WHOLE.** Node ids, branch
  case values and extracted field names are all quoted by a critic reading the workflow,
  and all are equally "already there" — scanning node ids alone sent the first complaint
  down the phantom-capability branch, the right verdict for the wrong reason, which is a
  bug waiting to be believed. Pinned by
  `tests/converger/a-complaint-must-be-actionable.test.js` (16), five mutations. **One
  survived and a source pin was added rather than the mutation dropped:** neutralising the
  call site left all 14 behavioural tests green, meaning the whole module could have been
  dead code with nothing to say so.
  **A stale pin in `user-has-the-last-word.test.js` was RE-POINTED, not weakened:** it
  matched the disqualifier condition verbatim (`if (covered || repeated ||
  contradictsUser)`) and so broke the moment a fourth term was added, though its invariant
  — that a user revision is *one of* the disqualifiers — was untouched.

- **A NEW USER WAS TOLD THEIR INBOX WAS CONNECTED WHEN NOTHING WAS — FIXED (witnessed
  2026-08-01 on a genuinely fresh tenant — the first time the product has been driven as
  someone who has just been given a login).** Brand-new workspace, nothing connected.
  First message: *"When a customer emails us asking about pricing, send me a summary in
  Slack."* Atlas asked **which Slack channel**, then said it would run *"whenever a new
  email lands in **your connected inbox**"* and offered a **Build it** button.
  **Ground truth, read from `oauth_tokens`, not inferred: ZERO rows for that tenant.**
  Six rows exist, all `agntic` and `platform`.
  **This is the open residual *"a connector's availability is only checked at BUILD
  time"* meeting *"Atlas confirms and elaborates capabilities it does not have"* — and
  both were filed against an experienced user losing an interview. For a NEW user it is
  the entire first impression, it is a false claim about their own account, and a fresh
  workspace has no connectors BY DEFINITION, so it happens every single time.** The
  hand-provisioned model Charles chose makes this the first thing every customer meets.
  **THE FIX, IN TWO HALVES, BECAUSE THE PROMPT ALONE ALREADY EXISTED AND FAILED.** The
  fact was in the prompt the whole time; it read *"No connectors are connected yet. **If
  asked**, say none are set up"* — and the user had not asked, they had described a
  workflow. Four words, and they are the entire defect. That block is now unconditional,
  says not to describe their setup back to them, and names what CAN be built with nothing
  connected (a schedule, web research, delivery to the Atlas inbox) so an empty workspace
  is not a dead end.
  The mechanism that makes being wrong about the model harmless is
  `src/api/chat-connector-gap.js`: when the proposed `build_intent` names a service the
  workspace does not have, the **Build it button is withdrawn** and a deterministic
  sentence names what to connect. Same fail-closed principle as *"publishing FAILS CLOSED
  when a trigger cannot be armed"*, moved to the first turn where it costs nothing.
  **IT FAILS *OPEN* ON EVERY DOUBT, and that direction is most of what the tests pin:**
  wrongly withdrawing the button traps someone at the first message of their first
  workflow with no way forward, while wrongly allowing only reproduces today's behaviour.
  So it fires only on an unambiguously named service that Atlas actually connects and
  definitely lacks. **A bare "email" deliberately does NOT imply Gmail** — "email me the
  summary" can mean the Atlas inbox, which needs no connector, and treating the word as a
  Gmail requirement would block the one shape a new user can actually build.
  Applied at **BOTH** `done` emitters — the ordinary one and the forced-final path — via
  one shared helper, because this file records a previous fix to this same endpoint that
  was blind to the second copy and left four guards green while the real path was
  unprotected. Pinned by `tests/api/no-build-button-for-what-you-lack.test.js` (19), six
  mutations red→green.
  **CONFIRMED LIVE (2026-08-01, v1.6.107) — AND HALF OF IT DID NOT LAND. Say both.**
  Re-driven on the same fresh tenant with the same opening message. The MECHANISM works:
  no Build it button, and the deterministic sentence named BOTH missing services —
  *"Before I can build this, Slack and Gmail need to be connected to this workspace — open
  Connections in the left sidebar to set them up."* **The PROMPT half did not:** turn one
  still asked *"Which Slack channel (or DM) should the summary land in?"*, and the model
  still wrote *"whenever a new email arrives in your connected inbox"* in the paragraph
  directly above the correction — so the false claim is now printed and then contradicted
  in the same message. Better than uncorrected, and not yet right.
  **This is the file's own rule earning its place again: a prompt is a belief about model
  behaviour and is pinned by nothing.** The guard is what made being wrong about it
  harmless, and being wrong about it is exactly what happened, immediately.
  **CORRECTED THE SAME DAY, ON CHARLES'S CALL, AND THE FIRST VERSION WAS TOO TIMID.**
  Reading the live result: *"the system should not try and build workflows at all with no
  connectors connected… it already affirmed building was possible without slack being
  connected."* He was right. Appending a notice left the model's design ON SCREEN ABOVE
  the correction — *"hit 'Build it' and I'll walk you through each step"*, an action that
  had just been withdrawn, over *"whenever a new email arrives in your connected inbox"*,
  which is false when nothing is connected. **A correction underneath a contradiction is
  not a correction: the reader believes the confident part.**
  Now the reply IS the instruction. The model's words are WITHDRAWN and replaced
  (`withdrawPartial` + `sendChunk`, the same path the navigation backstop uses) with a
  deterministic message that says what to connect, where, and what happens next — and
  never describes a setup that does not exist. Pinned by assertions that the reply
  contains no "Build it" and no "your connected".
  **AND THE PROMPT NOW STATES WHAT IS *NOT* CONNECTED, not only what is.** Listing only
  the connected services left the model to infer absence, and it inferred wrongly every
  time. The block names the missing ones and forbids asking for their settings.
  **EMAIL AS A TRIGGER IS GMAIL; EMAIL AS A DESTINATION IS NOT.** The first version missed
  the witnessed case entirely because a bare "email" is deliberately ambiguous — "email me
  the summary" can mean the Atlas inbox, which needs nothing connected, and treating the
  word as a Gmail requirement would block the one shape a brand-new user can build. But
  *"when a new email ARRIVES"* can only mean a mailbox Atlas reads, and the only one it can
  read is the connected Google account. Anchored on the ARRIVAL verbs, so "send me an
  email" and "reply by email" are untouched. Both senses are pinned, in both directions.
  **TWO MORE FIXTURES WERE WRONG, NOT THE FIX** — the same `build-offer-actionable.test.js`
  harnesses, now needing Google connected because their `BUILD_INTENT` is email-triggered.
  A workspace with Slack but no Google could not run that workflow, so asserting a build
  offer for it asserted a state production never produces. That rule has now caught the
  same file twice in one day.

  **AN EXISTING TEST WENT RED AND THE FIXTURE WAS WRONG, NOT THE FIX.**
  `build-offer-actionable.test.js` mounted the endpoint with `spine = {llm}` — no
  connector resolvers at all — and then asserted a Slack build offer, i.e. it was asking
  for a Slack button on an EMPTY workspace, a state production never produces. Its sibling
  harness in the same file already resolved connectors properly; the two now agree. That
  is the *"a check must construct its subject the way PRODUCTION does"* rule catching a
  fixture that had been under-specified all along.
- **"THEY HAVE BEEN EMAILED" IS A CLAIM ATLAS CANNOT SUPPORT (open, 2026-08-01).**
  Provisioning a workspace for `firstrun@example.test` — a **reserved, non-routable TLD
  (RFC 2606)** — reported *"has been emailed a secure link to set their password"* and
  logged `invited: true`. `sendMail` returns `delivered: true` when the provider call does
  not throw, i.e. *Resend accepted it*; bounces are asynchronous and **nothing consumes
  them** — no webhook, no record, no retry. The word degrades at every hop: *accepted* →
  `delivered` → `invited` → *"has been emailed"*, and the last hop is a promise to the
  operator about someone else's mailbox. **This is the only onboarding path in the
  hand-provisioned model and it is the one step the operator cannot observe.**
  *Circumstantial, NOT proven, and must not be reported as cause:* of five real people
  provisioned 8–10 July, **four never signed in** and the fifth signed in once. Whether
  their invites bounced **cannot be established** — the logs retain only back to 25 July.
  It is a reason to instrument, not a conclusion. Fix: say "queued with the mail provider",
  return the invite link ALWAYS so it can be delivered another way, and surface it for
  re-sending. Full write-up:
  [`docs/handoff/first-run-findings-2026-08-01.md`](docs/handoff/first-run-findings-2026-08-01.md).
- **THREE PIECES OF TEXT A CUSTOMER READS CLOSELY — ALL FIXED (2026-08-01).** Each was
  found by using the product, each sits on a screen someone points at, and none broke
  anything: they only ever looked broken.
  · **A Gmail query rendered as garbage.** `_plainFilter` split on whitespace, so
    `subject:(buy OR buying OR purchase)` came out as *mentioning "(subject:(buy)",
    mentioning "OR", mentioning "buying"…* — on the FIRST card of the walkthrough. Open
    since 2026-07-30. A grouped term is now lifted out and read as ONE condition
    (*"with buy, buying or purchase in the subject"*). Deliberately narrow: only
    `key:( … )` is handled, because that is the shape the converger writes, and every
    ungrouped filter renders byte-identically — asserted for six of them, because a
    regression there would be worse than the bug.
  · **"a Google Sheet"** on the step card immediately before Run test, on a build that
    knew exactly which sheet and tab it meant. Now *"the Sheet1 tab of the Agntic CRM
    Google Sheet"* — and **the opaque id is never shown**: once discovery resolves the
    sheet, the 44-character key tells a reader nothing, and printing it is the errand
    this product spent a day removing. Falls back to the tab alone, then to the old
    wording, so it can only ever say something true.
  · **THE CHANGELOG-AS-WELCOME-MAT WAS NOT A MISSING GATE — THE GATE LOOKED IN THE WRONG
    PLACE.** `_loadWhatsNew` tested `localStorage.getItem('atlas_tutorial_done')`, which is
    per-ORIGIN and therefore **shared by every Atlas account ever signed in on that
    browser**. The fresh tenant's first-ever login showed the full v1.6.106 release notes
    because the flag was already set by a different account in the same Chrome profile.
    Keyed per user now, with the old unscoped key honoured so an existing user is not
    handed the backlog once by the change, and defaulting to NEW when nothing can be read
    — a new user seeing no notes loses nothing; seeing the backlog is the defect.
  Pinned by `tests/api/three-things-a-viewer-reads.test.js` (15), three mutations
  red→green. The renderers are EXTRACTED FROM THE PAGE AND EXECUTED, never copied. The
  page was served on :8899 and loaded in a browser with a clean console before deploying,
  per the rule written after v1.6.65.
- ~~**A new user's first screen is a CHANGELOG**~~ *(open item, closed by the entry above.)* The What's-New modal
  fires once per user on the login after a release; a user whose FIRST login follows one
  gets five engineering changes — *"Give Atlas a test case without it rebuilding your
  workflow"*, *"A workflow that only acts on one path can go live"* — describing repairs
  to problems they have never met, in vocabulary they do not have, before they have seen
  the product. Suppress it when the account has never signed in.
- **Approval-channel availability (`email`) is deployment-wide, not per-tenant** — fine today
  (one deployment, one mailer); revisit if tenants ever bring their own sending domain.
- **A PROMISE ABOUT ONE BRANCH WAS WRITTEN UNCONDITIONAL, AND A REAL EMAIL FAILED IT
  — FIXED (2026-07-31, witnessed on prod `build-platform-1785510779068`).** A correct
  Gmail→Sheets logger — classify, append a row on the "yes" lane, do nothing on the "no"
  lane — reached *"Contract not met · 1 of 3 promises fell short"* and **could not go
  live**. It also bought **two paid whole-spec Opus passes** (80s each) before the rebuild
  gate correctly refused a third.
  **Measured from the build's own checkpoint, not inferred:**
  · The single assertion is `{"id":"a1","kind":"record_exists","target":"sheets:Sheet1"}` —
    **no `when` field at all**. The human half of the same promise IS conditional: *"When a
    new email arrives **that looks like a pricing enquiry**…"*. So the sentence a person
    reads is gated and the machine-checkable half is not.
  · The failing example is `{"id":"19f8b9524a03773d","label":"[Action Required] Enable
    2-step verification … Google Cloud <CloudPlatform-noreply@google.com>"}` — **no
    `expect`, no `shouldTrigger`**. It is a REAL email sampled from the connected inbox,
    and it is plainly not a pricing enquiry.
  · The two generated lane examples both carry their flags (`lane_2` has
    `shouldTrigger: false`) and were scored correctly — **kept ✓ and not exercised ○**.
    Three examples, same workflow, and the two that declared themselves were judged right.
  **WHY THE EXISTING GUARDS ALL MISS IT, which is the point:** the quiet-path fix
  (2026-07-29) excuses a negative, and `negative` requires `shouldTrigger === false` or
  `expect === null` — deliberately, because treating an undeclared example as negative is
  the F17 regression. And `CONDITIONAL_MISSTATED` (2026-07-28) restates a `when` that names
  the WRONG route; it does not fire when `when` is **ABSENT**. **Absent and wrong are being
  treated as different things, and the missing case is the unguarded one** — the same shape
  as the malformed-trigger defect (*"a guard that does not recognise a value must not read
  that as nothing to check"*), inverted, and now on its fourth appearance in this file.
  **Why it matters more than one build:** classify-then-act-on-one-lane is the commonest
  shape in the product. Other builds of this shape go live only because every one of their
  examples happened to declare itself. Sampling a REAL inbox message — which is what makes
  the test meaningful — is what exposes it, and whether a sampled real email matches is
  unknowable until the classifier runs.
  **NOT caused by the Sheets discovery work shipped the same day** — checked: the
  assertion was written by the `outcome` node at step 0, before any of that code runs, and
  the destination itself resolved correctly (the panel named the real file id
  `1DG5qZ9mHvTITU34iGRKWf9-vPyegVufENVmoJLcdnSA`, and the row step carried it).
  **THE FIX.** The loop that restates a condition opened `if (!a?.when) continue`, so an
  absent one was never looked at. It now handles that case with the SAME mechanism and the
  same `set_assertion_when` repair — new code `CONDITIONAL_UNSTATED`, applied by
  `autoRepairStructural` with no question, no model call and no rebuild. The user's
  `statement` is untouched; only how the promise is CHECKED changes.
  **WHY FILLING IT IS EXACT AND NOT A NARROWING**, which is the whole correctness argument:
  `gatingRouteFor` returns `null` unless some lane of a branch genuinely does NOT reach the
  step, so a promise that really is unconditional is left alone. When it IS gated, the step
  cannot run on any other lane — so the unconditional promise is not merely unproven, it is
  **false as written**, and every run down another lane fails it. Filling the condition makes
  the checkable half agree with what the workflow does and with what its own sentence already
  said. Two candidate gates are never guessed between, and a promise NO step keeps is left
  alone so that "this names somewhere no step goes" survives as a finding.
  Pinned by `tests/converger/a-promise-about-one-branch.test.js` (13), **four mutations
  red→green** — the two that matter are the dangerous direction: filling a condition when
  nothing gates the step (4 red) and guessing between two candidate gates (1 red). A promise
  quietly weakened until it passes is the one thing the promise system may never do.
  **The fixture is the REAL spec, lifted verbatim from the prod checkpoint.** A hand-written
  approximation was tried first and the validator rejected it on four counts before it ever
  reached the check under test — `classify` carries `categories`, the branch's catch-all is a
  `when: "*"` CASE rather than an `otherwise`, and the quiet lane is a `stop` node. None of
  that was guessable, and it is the "construct the subject the way PRODUCTION does" rule
  earning its place again.

- **CONFIRMED LIVE (2026-07-31, v1.6.105), and what it did NOT fix.** The same build
  re-run on prod (`build-platform-1785513701920`) after the condition fix:
  `converger.pre_regen_repair {applied: ["CONDITIONAL_UNSTATED"]}` in the log, then
  **verify in 5.5s with no rebuild at all** — against 42.9s and two paid whole-spec passes
  before. Plan-approval to walkthrough: **96 seconds, was 4m10s.** In the panel the
  example that used to read *broken* — a non-matching email — now reads **not exercised**,
  and the run reports *"nothing broke"*. Three examples, **zero broken**, where it was one.
  **It is still not cleared to go live, for a DIFFERENT and correct reason:** this build's
  second path is an ERROR lane that no example took, so the verdict is the honest
  *"Contract not verified — nothing went down one path"*. That is the by-design rule that a
  workflow which routes is only proved on the routes you test, not a residue of this defect.
  **TWO MORE DEFECTS FOUND THE SAME WAY, BOTH NOW FIXED (2026-07-31), and they
  compounded into "a correct workflow cannot be cleared to go live":**
  · **COUNTING IS NOT COVERAGE.** The top-up that gives every path a test input skipped,
    because its gate read `lanes.length <= have.length` — two COUNTS. Measured on that
    build: `lanes: 2, had: 3`, all three samples aimed at the SAME path, the other path
    left with nothing, logged as `enough_samples_already`. The nth instance of a check
    scoped to the SHAPE of a value — here its quantity — rather than to what it is for.
    An example now CLAIMS a path (`lane`), and only a claim counts as cover; an example
    that claims nothing covers nothing, because attribution is unknowable for samples
    generated before the workflow existed and **"we cannot tell" must never read as
    "covered"**. The top-up is then asked only for the paths still open.
  · **ASKING FOR A TEST CASE IS NOT ASKING FOR A CHANGE.** Because the path was unproved,
    the panel asked for an example in its own words — *"give me an example that takes it
    and I'll check the rest"* — and typing one took the `ratify_feedback` route into a
    **107-second whole-spec regenerate** that renamed the route from `error` to `none` and
    **did not add the example**. The one remedy the product offers cost a paid rebuild,
    did not work, and moved the spec underneath someone who had asked for nothing to move.
    `src/converger/test-case-request.js` now decides it, and **both doors into the
    regenerate share it** (the walkthrough's "request changes" and ratify's feedback) —
    a rule about what a person's MESSAGE MEANS, written twice, is the shape this file
    records paying for most. A test case is added to the spec and the SAME spec is
    re-presented; nothing is rebuilt.
  **CONFIRMED LIVE (2026-08-01, v1.6.106), and the honest split.** Same request, fresh
  build (`build-platform-1785550053796`): `converger.lane_examples {lanes: 2, had: 1,
  added: 2}` — the top-up RAN where it had skipped — verify passed with no rebuild, the
  self-check reported **`consistent`** (the `PROMISE_AND_SENTENCE_DIFFER` false positive
  did not recur), and the panel read **"Contract kept · every promise held — it's cleared
  to go live"** with **Go live unlocked**. The real inbox email that was scored BROKEN two
  builds earlier is now correctly `not exercised`. That is the first time in this campaign
  a classify-then-branch Sheets workflow reached go-live.
  **NOT witnessed live: the test-case door itself.** With every path claimed there was no
  unproved path left, so the state that offers the door never arose — the upstream fix
  removed the need for it. Its code is pinned by 21 tests and six mutations and is
  UNPROVEN IN A BROWSER; say so rather than implying the whole change was seen working.
  Reaching it now requires a build whose paths the top-up genuinely cannot cover.

  **THE DECISION IS NOT SCOPED TO THE WORDING.** "Test the error path" and "it should also
  handle an empty body" are one sentence to a regex and opposite requests to a person. Two
  things must hold: a path is genuinely unproved (so Atlas actually asked), and the model
  says it describes an INPUT. **Every doubt, malformed answer and failure resolves to
  CHANGE** — exactly the behaviour that shipped before — because reading a real change
  request as a test case would silently ignore someone asking for their workflow to be
  different, which is far worse than the rebuild this removes.
  Pinned by `tests/converger/an-example-is-not-a-change.test.js` (21), **six mutations
  red→green**; the ones that matter are the dangerous direction (an unrecognised answer
  read as a test case, an example accepted that names no path).
  **THREE PINS IN `lane-examples.test.js` WERE RE-POINTED, NOT DELETED, AND ONE WAS
  ASSERTING SOMETHING FALSE:** *"only when there are fewer samples than paths"* stated the
  count rule as an invariant. Its real invariant — a build that needs no top-up must not
  pay for a model call — is kept; only how "needs" is decided changed. Two others used
  fixed byte windows (900/2600 chars) that the node outgrew, so they failed over
  formatting rather than behaviour, and are now anchored to the node.
  **AND TWICE IN ONE SESSION A SOURCE-LEVEL TEST MATCHED A COMMENT RATHER THAN CODE** —
  once mine, once the existing one, both searching for the very expression the comment
  above the fix quotes in order to explain why it was wrong. A source pin must be scoped
  to the GATE EXPRESSION, never to the words. A third was a true invariant reported as
  broken because a braced callback added a `return {` the counter mistook for a node exit;
  the code was written the other way rather than the test weakened.

- **THE SPREADSHEET PICKER FIRED ON A WORKFLOW WITH NO SPREADSHEET, AND BLOCKED THE
  BUILD — FIXED (2026-08-01). A regression from the SAME MORNING'S fix, found by driving
  a real build on a fresh tenant.** A Gmail→filter→Slack workflow stopped mid-build and
  asked *"Which Google Sheet should this write to?"*, listing ten of the customer's real
  spreadsheets, then sat waiting for an answer about a resource it does not use.
  **Cause:** making `usesConnector` read the capability's DECLARED connector was right for
  the write side — `sheets_append` belongs to `google`, not to `google_*` — but
  `schemaDiscovery` is declared per CONNECTOR while describing ONE resource shape. So
  `gmail_search`, `calendar_*` and `docs_*` all began matching Google's spreadsheet
  descriptor. **A fix scoped one level too wide, by the same author, on the same day.**
  Now a node must ACCEPT the container key the descriptor fills (`spreadsheetId`,
  `baseId`): scoped to what the capability CAN HOLD rather than to who it belongs to.
  **It fails OPEN on an undeclared schema** — a capability with no `configSchema` has not
  said it cannot hold the key, and narrowing on silence would have excluded the P13-0
  synthetic MCP connector, whose own test caught exactly that on the first attempt.
  Both halves narrow identically, or a spreadsheet id gets written into a Gmail search
  node's config — an undeclared key, which is a hard publish failure. Pinned by four new
  cases in `sheets-can-be-picked-not-pasted.test.js` (25), two mutations red→green.

- **ONE DEFECT, THREE ACCUSATIONS, ONE PAID PASS: `isOpaqueProviderId` KNEW EXACTLY ONE
  VENDOR — FIXED (2026-08-01).** Measured on `build-zz-firstrun-test-1785614912754`, a
  completely correct Gmail→Sheets logger built minutes after the entry below. The promise
  said `sheets:Agntic CRM` — the words the person used — and the step carried the
  spreadsheet id discovery had just resolved. Compared as strings, they differ, so the
  build was told three separate times that it delivered nowhere:
  · `UNSATISFIED_ASSERTION` → **a paid whole-spec Opus pass rebuilding a spec that was
    already right** (87s + 66s, two passes where one was needed);
  · `gap_answer` → *"no step in this workflow does that — the request would be silently
    dropped"*, and the rebuild gate refused a THIRD pass only because the same complaint
    had been made once already;
  · the self-check's `STATEMENT_NAMES_ELSEWHERE` → *"the promise tells the customer this
    workflow delivers to 'Agntic CRM', but no step in it does"*.
  **All three consult one function**, which is why one line fixed all three — and why
  getting it wrong produced three independent false statements about one workflow.
  **The rule was `/^(app|tbl|rec|fld|viw)[A-Za-z0-9]{14}$/` — Airtable's id format and
  nothing else.** A Google Drive file id is 44 characters of `[A-Za-z0-9_-]` and matched
  none of it, so for Google Sheets this protection may as well not have existed. It is
  **the same defect fixed for Airtable on 2026-07-28** (*"a successful Airtable write was
  reported as a broken promise"*), arriving through a door that fix did not cover, and the
  nth instance of a rule scoped to the FORM of one vendor's name.
  The question it actually asks is *"could a person have said this?"*, and the threshold is
  now **the one `_destinationOf` in `public/index.html` already uses** to decide it must
  never print an id to a customer — deliberately the same number, so the product has ONE
  answer to "name or identifier" rather than two that drift.
  **THE COST IS REAL AND IS RECORDED IN THE TESTS, NOT ARGUED AWAY.** A 44-character key
  could name any spreadsheet, so *"no step goes there"* becomes genuinely UNDECIDABLE for a
  spec carrying one. An existing pin — *"a promise no step keeps is NOT quietly given a
  condition"* — was asserted against the real prod fixture, which carries exactly such an
  id; it now names the spreadsheet readably so the invariant is stated where it CAN be
  decided, and **a new case records the honest answer for the opaque version** rather than
  hiding it. Same trade already accepted for Airtable, bounded the same way: an id in a spec
  is one the connector's own list produced, and a wrong one fails the write at run time.
  **AND THE DUPLICATE I HAD WRITTEN TWO HOURS EARLIER WAS DELETED.** `looksLikeAnIdentifier`
  in `destination-create-or-pick.js` was a second copy of this same rule, written while
  fixing the entry below — the exact shape this file records paying for more than any other,
  committed by the person documenting it. One definition, imported.
  Four mutations, **three killed** (Airtable-only → 1 red; threshold 25→5, i.e. fail wide
  open → **12 red across five files**; dropping the Airtable branch → 2 red). **The fourth
  was an explicit whitespace guard and proved UNKILLABLE — both branches already exclude
  whitespace, one by anchoring and one through its character class — so it was REMOVED
  rather than left as a guard no test can hold.**
- **THE PICKER COULD ONLY OFFER SHEETS THEY ALREADY HAD — FIXED (2026-08-01), AND THE
  FIRST ATTEMPT WAS WORSE THAN THE BUG.** Witnessed on a fresh tenant the day after the
  picker shipped. It worked: ten real spreadsheets by name, no ids, the chosen sheet's real
  columns read back and a mismatch flagged. Then, told *"don't touch that one — create a
  fresh sheet called Buyer Inquiries for this instead"*, the build stopped mid-way and asked
  *"Which Google Sheet should this write to?"*, listing the same ten, **none of them Buyer
  Inquiries**. A question with no correct answer. Slack has had create-or-pick since
  2026-07-24 (*"a genuinely un-defaultable choice — a destination that doesn't exist — is
  still asked conversationally and applied DIRECTLY"*); **Sheets got the pick half and never
  got the create half.**
  **THE FIX TRIED FIRST IS THE PART WORTH REMEMBERING.** Skipping the picker and carrying the
  named sheet through turned **eight** destination-adversarial tests red, one of them *"a base
  id the connector never listed cannot survive into the spec"*, whose own comment reads *"a
  guess writes the customer's lead into a base that does not exist."* That guard is right: a
  workflow bound to a spreadsheet nobody has writes a customer's data nowhere and reports
  success. **It traded a dead end for a silent failure. It was reverted before shipping.**
  So the invariant is KEPT and the missing half is BUILT: the sheet reaches the spec by being
  **created**, after which it is a real container with a real id and every existing check
  passes for the ordinary reason. New `sheets_create` (declaring `oneTimeSetup`, so
  `SETUP_ACTION_AS_STEP` keeps it out of the run path exactly as it does for
  `airtable_create_field` — a spreadsheet re-created on every email is that defect again),
  and `createCapability`/`createNameArg`/`createColumnsArg`/`createIdKey` on the
  `schemaDiscovery` descriptor.
  **THREE RULES, each a way this could have been made dangerous** (`destination-create-or-pick.js`):
  a name is offered for creation **only** when the connector DECLARES it can create one
  (Airtable declares none — a base needs a workspace id nobody has been asked for — so its
  picker is untouched); **only** when we genuinely listed, because *"they do not have it"* is a
  claim and a connector with no list capability compared nothing; and **only** when the value
  reads as a NAME rather than a machine id, since offering *"Create a new Google Sheet called
  1DG5qZ9mHvTl…"* is what a model's invented id looks like. It reads the WRITE NODES, never
  the conversation — substring-matching free prose is the trap already recorded against
  `retargetStaleAssertion`.
  **CREATING IS THE DEFAULT when a named sheet is absent, and that is a deliberate choice of
  which mistake to make.** The alternative default is `containers[0]`, an unrelated
  spreadsheet the person never mentioned: a new empty sheet nobody wanted is noise, a row
  appended to their real CRM is not. The same reasoning governs an unreadable answer.
  **The count gate had the same defect the lane top-up had**: `bases.length > 1` meant that
  with ONE spreadsheet in the account and a different one named, no question was asked at all;
  and the `!bases.length` pass-through swallowed the case a brand-new workspace hits every
  time — no spreadsheets, one named, nothing to pick and one real thing to do.
  **CONFIRMED LIVE (2026-08-01, v1.6.115) — AND THE FIX WAS THE WRONG SHAPE. Say both.**
  Driven on the fresh tenant: the option appeared FIRST and pre-selected — *Create a new
  Google Sheet called "Buyer Inquiries"* above ten real spreadsheets — clicking it really
  called `sheets_create` against Google (`builder.capability.ok`), and the workflow bound to
  the new id in one paid pass. The dead end was gone. **Charles, watching it:** *"It did it
  again. All questions and details should be worked out before the build commences."*
  **He is right, and it is his own call from 2026-07-28** — carried since as the top open
  item, *table-shaped destinations must be settled BEFORE the plan, for every connector*.
  The fix above changed WHICH ANSWERS the question offers; it never touched the fact that a
  build stops and asks. Two defects, one shipped.
  **AND THE OLDER HALF WAS A REAL BUG NOBODY HAD NAMED: `isKnownBase` COMPARED IDS ONLY.**
  Airtable's model writes a base id it learned from `airtable_describe_base`; a Sheets user
  says *"Agntic CRM"*, and that is what the build records. So the "this was already
  answered" test **could never fire for Google Sheets**, and the picker asked on **every
  single Sheets build** — including when the person had named a spreadsheet they own and
  the plan card had quoted it back to them. That is why this kept being seen as "it asks
  again"; it was not a create-vs-pick problem at all.
  **NOW THE QUESTION IS ASKED ONLY WHEN THE BUILD GENUINELY DOES NOT KNOW.** One decision
  with three answers (`resolveNamedContainer`), and each branch is a different argument:
  · **they have it** — matched by NAME as well as id ⇒ use it, ask nothing;
  · **they named one they do not have** ⇒ CREATE it, ask nothing. Not un-answered: they
    named it, the plan card names it, and they approved that plan. **Request a change is
    the door if the name is wrong**; asking again here is the interruption being removed;
  · **nothing usable recorded** ⇒ ask, exactly as before. The only ambiguity left.
  **The picker's create option was DELETED rather than left unreachable** — with a name
  present the build never reaches the picker, so an option that cannot be shown is code
  claiming to do something it cannot. An unresolvable machine ID still falls through to the
  question rather than being created, which is what keeps *"a base id the connector never
  listed cannot survive into the spec"* green.
  Pinned by `tests/converger/a-sheet-you-do-not-have-yet.test.js` (25), **seven mutations
  red→green**; the two that matter most are reinstating the id-only match (3 red) and
  putting the interrupt back on the settled path (1 red). **One survived the first pass and
  the fixture was strengthened rather than the mutation dropped:** "the first usable answer
  decides" was not a real invariant and could not distinguish first-wins from last-wins —
  replaced by the one that is (*a blank or a template must be SKIPPED, not read as "no
  destination"*, which would send a build that knows its destination into the question).
  Five pins are SOURCE-level and say so: the `destinations` node closes over the LLM, the
  graph state and `interrupt` and cannot be lifted, and "the decision was right and nothing
  consulted it" is how the P13-0 destination fix was silently reverted with the suite green.
  **The remaining "nothing was recorded" case still asks mid-build** — rare, since the model
  almost always records what the person said, and genuinely un-answerable any earlier.
- **A PERSON NOW PICKS THEIR SPREADSHEET INSTEAD OF PASTING ITS ID — FIXED
  (2026-07-31, increment 2 of "the conversation as a tool").** The errand this replaces,
  witnessed on prod: *"What is the spreadsheet ID for 'Pricing Enquiries'? You can find
  it in the URL of the sheet, between /d/ and /edit."* — asked AFTER offering "the
  spreadsheet ID **or name**" and being given a name. `sheets_describe` now declares
  `schemaDiscovery`, so the same code path that has always produced good Airtable
  questions produces one for Sheets: the spreadsheets are read from Drive and offered by
  name. Asking rule 2 ("never ask what was never looked up") was only as good as the
  discovery behind it, and for Sheets there was none to attempt.
  **THE SEAM COULD NEVER HAVE WORKED FOR GOOGLE, WHATEVER IT DECLARED, AND THAT IS THE
  PART TO REMEMBER.** `usesConnector` — which decides which nodes belong to a connector,
  on BOTH the read side (`resolveSchemaDiscovery`) and the write side
  (`fillDestination`) — matched the capability id's PREFIX. That is true of Airtable
  (`airtable_create_record` / connector `airtable`) and **false of every Google
  service**: `sheets_append` belongs to connector `google`, and
  `'sheets_append'.startsWith('google_')` is false. So a correct declaration still
  resolved to `null`. **The nth instance of a rule scoped to the FORM of a name rather
  than to what the thing IS** — the capability declares its connector, and the
  declaration is now what is asked. Had only the read side been fixed, the picker would
  have appeared, the person would have chosen "Pricing Enquiries", and the id would have
  been written onto NO node — ending in the very question it exists to replace.
  **THREE MORE SHAPE MISMATCHES, all Airtable's shape being ASSUMED rather than
  declared** — the same mistake as the hardcoded connector strings this seam was built to
  remove, one level down: the list capability was invoked with **no arguments** (Airtable
  needed none; Drive would have returned every file, PDF and image in the account — now
  `listArgs`); a Sheets tab returns `{sheet, headers}` with **no `id` and no `name`**,
  and the consumer read `x.name.toLowerCase()` literally, which would have **thrown on
  the first Google Sheet** (now `tableIdKey`/`tableNameKey`, defaulting to `id`/`name` so
  Airtable is untouched); and a column is an OBJECT in Airtable but a bare STRING in
  Sheets, so every downstream `.name` read — the field mapper, the assertion rewrite, the
  log line — would have seen `undefined` and mapped the promise onto a row of blanks.
  Normalised once, where the shape is known, rather than teaching four readers about both.
  Pinned by `tests/converger/sheets-can-be-picked-not-pasted.test.js` (21), **eight
  mutations red→green**. Every test drives the REAL registry and the REAL return shapes of
  `driveListFiles` and `sheetsDescribe`; a fixture shaped the way the author imagines is
  what hid all four mismatches. **One mutation survived the first pass and the test was
  rewritten rather than the mutation dropped:** "the consumer actually passes `listArgs`"
  built its own `invokeCapability` double and then **called it itself** with
  `descriptor.listArgs`, so it passed whatever the real consumer did. A test that
  re-implements the code under test proves only that the test can call a function; it is
  now a SOURCE-level pin that says so in its own header, because the destinations node
  closes over the LLM and graph state and cannot be lifted.
  **NOT witnessed in a browser yet** — code-proven only; a live Sheets build is the
  pending confirmation. **Still open from the original finding:** the picked sheet's
  existence is proven by the discovery read (a fabricated id can no longer be typed at
  all), but the plan card's rendering of a raw id is untouched wherever one is already
  stored.

- ~~**Google Sheets has no destination picker, so Atlas asks a customer for a spreadsheet
  ID**~~ *(the original finding, 2026-07-30, closed by the entry above).* Witnessed on prod: Atlas asked *"Which Google Sheet should I
  append the rows to? (I need the spreadsheet ID **or name**…)"*, the user answered with
  a name as invited, and Atlas then refused the name — *"What is the spreadsheet ID for
  'Pricing Enquiries'? You can find it in the URL of the sheet, between /d/ and
  /edit."* For Airtable, Atlas reads the tenant's real bases and proposes them; the
  connector-generic destination discovery built in P13-0 (`schemaDiscovery`,
  `sheets_describe`) is not wired for Sheets. **This is the banned developer-settings
  errand in all but name** and it is the most visible thing on a screen recording of the
  Sheets shape. Also: it never verified the sheet existed (a fabricated id was accepted),
  and the plan card printed the raw 44-character id to the customer.
- **`tests/e2e/full-journey.test.js`'s converger test is BROKEN, not skipped** — it dies in
  1.6ms with `ReferenceError: tenantId is not defined`, so it never reaches the model.
  Pre-existing (confirmed by stash, 2026-07-30) and it is the test P11's own gate notes
  warn about passing vacuously. Along with the ~5 failing `onboarding.test.js` tests, the
  E2E suite has 7 broken windows nobody owns.

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
- **The plan no longer claims "you said" about things nobody said.** *(Superseded 2026-07-27: the plan card's marks were removed entirely — see Hard-won lessons.)*
- **A step is shown before you are asked to approve it**, and an answer with no path is
  called out instead of being absorbed by the catch-all.
- **The chat no longer invents Atlas's own screens.**

**The rebuild loop was diagnosed, and it was never the model's first draft
(2026-07-28, QA on prod v1.6.46). Code-proven; a live witness is still pending.**

The question that had been asked repeatedly — *"is the first generation just not good
enough?"* — has an answer, and it is **no**. Measured on prod, build
`build-platform-1785252448380`: **four** whole-spec passes, 221s + 126s + 142s + 120s
≈ **10 minutes**, on a spec `scoreGap` had already returned `complete: true` for. Every
one of the four was ordered by the **sufficiency** route — the fast-tier *"is this
finished?"* opinion asked AFTER the validator and contract-coverage checks have both
passed — and every one named the same thing missing: the Slack DM to the approver. It
was never missing. **The `human` approval step sends that DM itself**, which is exactly
why there is no separate delivery node for it (a second one would message the person
twice). The Opus pass even reasoned *"the human step satisfies a1 ✓"* and was overruled
anyway.

- **Why it also broke the test panel.** The per-path example top-up lives in the
  `verify` node. The build spent its regenerate budget in the sufficiency loop and went
  `analyze → walkthrough`, never reaching `verify` — so a five-path router was handed to
  the panel with **one** example and could not possibly cover its own routes. *The
  "only one test example" symptom and the "why is it regenerating" symptom were one bug.*
- **Fix.** The blocking-gap route has had a "the complaint didn't change ⇒ the rebuild
  can't fix it ⇒ stop" guard (`_lastBlockerKey`) since 2026-07-26. The sufficiency route —
  which orders the most rebuilds — had no equivalent. It now has `_lastMissingKey`, plus
  the stronger rule that **an unverified opinion may not overrule a passing check**: a
  `complete:false` naming a destination the *contract already asserts* is discarded
  (`sufficiencyClaimAlreadyCovered`), because `scoreGap` has just said that assertion
  holds. Logged as `converger.sufficiency_overruled` — the route that drove the most
  rebuilds and recorded the fewest now records both. Pinned by
  `tests/converger/sufficiency-overrule.test.js` (10, mutation-verified red→green two
  ways; the anti-false-pass cases prove a genuinely missing component still rebuilds).

**A successful Airtable write was reported as a broken promise — FIXED (2026-07-28).**
Witnessed on prod: the record was created, and the panel said *"nothing reached "Table 1"
in Airtable — this run delivered to tblbQ0PmkA2o1P17Q (Airtable), and nothing else."*
Both halves name the same table. Go live stayed locked on a workflow that had done
exactly what it promised. **Root cause: two checkers disagreeing about identical data.**
`satisfiesAssertion` (build time) has always treated an opaque provider id as
*undecidable* — you cannot know whether `tblbQ0PmkA2o1P17Q` is `Table 1` without asking
Airtable — while `checkAssertionAtRuntime` compared the same two strings **without** that
rule, under a comment claiming it mirrored the build-time check. So the build published
the workflow and the run then failed it. The rule is now one shared, exported
`isOpaqueProviderId` used by both. **The guarantee is not weakened:** the dry-run `probe`
independently reads the base schema and fails a table that genuinely is not there, so
existence is still proven — by the mechanism equipped to prove it. Pinned by
`tests/workflows/airtable-id-vs-name.test.js` (7, mutation-verified; a wrong
*human-named* table, a refused write, a wrong connector and no delivery at all all still
fail). **Only reachable when Airtable actually works** — a dead connector fails earlier,
which is why local testing never saw it.

**A correct approval workflow could never pass its own test — FIXED (2026-07-28).**
The converger wrote the channel-post promise as `when: "urgent_complaint"` — the
CLASSIFIER lane — when the post actually sits behind the APPROVAL gate two branches
down. Atlas deliberately runs every gated example both ways, so each **reject** pass
was scored as a broken promise for not posting the message that rejecting exists to
withhold. Witnessed: *"Contract not met · 4 of 9 promises fell short"*, three of the
four being reject passes, Go live locked on a workflow behaving exactly as designed.
**The old check was the laundering hop** (trap #3): it asked *"does SOME branch route
on this value?"* — a question about the vocabulary — when the question is *"is this
what gates THIS step?"*. `gatingRouteFor` has always computed the right answer and its
own comment names this exact failure; it was simply never consulted once `when` looked
like a valid route. Now a `when` that is a real route value but not the gating one
raises `CONDITIONAL_MISSTATED` carrying a `set_assertion_when` fix, applied by
`autoRepairStructural` with **no question, no model call, no rebuild**. The deepest
gate implies every gate above it, so this is exact, not a narrowing — and the user's
own `statement` is untouched; only the machine-checkable `when` is restated. Pinned by
`tests/converger/conditional-misstated.test.js` (6, mutation-verified red→green;
anti-false-pass cases prove a promise that already names its gate, one gated only by
the classifier, and an unconditional one are all left alone).
*Measured across the workspace beforehand: **7 of 16** approval-shaped workflows carried
a mis-stated or uncheckable condition — this was a coin flip, not an edge case.*

**The lane-example top-up now says when it adds nothing.** `verify` ran for 19.2s on
prod and a five-path workflow still reached the panel with ONE example, with nothing in
the log to say why: the failure path was a bare `catch {}` and the "returned zero" path
did not exist. Both now log (`converger.lane_examples_empty` /
`lane_examples_failed`). **This is instrumentation, not a fix** — the top-up is still
not producing per-path samples on prod, and the cause is still unknown. Next build's log
will name it.

**The approval step's DM went live unverified — FIXED (2026-07-28).** On an
otherwise PASSING prod run: *"Nothing in this run could check hello@agntic.co on
Slack, so that part is still unproven."* The workflow did send it — the approval step
is what sends it, which is the whole reason there is no separate delivery node (a
second one would message the person twice). **The same build-time/runtime asymmetry
as the Airtable id above:** `satisfiesAssertion` has always counted a `human` node's
ask (`askSatisfiesAssertion`), while a run's deliveries were assembled as
`isDeliveryNode(node) || output.delivered === true` — and a `human` node is neither,
so the ask was invisible to the oracle. One of three promises certified as unproven on
a run that kept it. **Both collection sites now call one shared `deliveriesForStep`**
(`dry-run-runner.js` and `POST /workflows/run` each carried their own copy of the rule,
a comment apart — that duplication is how build and runtime drifted). The narrowing is
inherited whole from `humanAskTargets`: slack/inbox only (an `email` ask is a platform
magic link, not the tenant's connector), each channel matched as its own
connector+target pair, never pooled. Reaching the node is the evidence — `steps`
contains only nodes that executed. Pinned by
`tests/workflows/ask-counts-at-runtime.test.js` (9, mutation-verified red→green;
anti-false-pass cases prove a different person, an email ask, a record promise, a
channel-less ask and cross-channel pooling all still fail).

**Still open, roughly in the order they matter:**

0. **Table-shaped destinations must be settled BEFORE the plan, for every connector
   (operator, 2026-07-28).** Today Atlas asks which base/table, builds the whole
   workflow, and only then discovers the columns don't match — two of three generate
   passes on the last prod build were spent on exactly that, and no amount of
   regenerating can create a column in someone's account. Atlas already reads the real
   schema; it just learns it too late. **Decided:** at the clarification turn, read the
   destination's real columns and show them — *"Table 1 has Name, Notes and Date. I'll
   put the sender in Name and the subject + summary in Notes — or tell me to add Subject
   and Summary columns."* One question, answer applied directly, no rebuild.
   **This is a per-capability trait, never a per-connector special case** (operator:
   *"every table style data source regardless of connector"*) — Sheets, Notion and
   anything later must get it from the same mechanism, in line with the closed decision
   that the codebase is workflow-agnostic.

0b. **One workflow, four different published shapes.** Measured on the prod build
   (12 nodes, 2 branches): the test panel says **3 steps · 3 paths**, step approval says
   **13**, the plan card said **8 steps · 4 paths**, the oracle counts **5 lanes**. The
   panel's count stops at the FIRST branch, so it structurally cannot see an approval
   gate downstream of a classifier. Each surface recomputes the shape with its own rule
   and they disagree — so the number a person reads is not the number the oracle
   certifies against. Needs one derivation of "what shape is this workflow" that every
   surface reads. *(Does NOT explain the missing test examples — that is the separate
   silent top-up above. Do not conflate them; it has already been done once.)*

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
    connector-generic destination schema discovery — `sheets_describe` was
    finally WIRED on 2026-07-31, and doing so exposed four shape assumptions the seam had
    inherited from Airtable; see the Sheets picker entry in the residuals). Gate `scripts/gates/p13.sh` is progressive and
    fail-closed. Apply the increment-loop review calibration: block only on defects
    a real user can hit that either look like success or destroy something;
    everything else is recorded and carried. Branch per increment off `main` → PR →
    squash-merge; the phase closes only on the final merge carrying `Gate: P13` +
    `Phase:` + `Verified-by:` from a fresh verifier who did not write the code.*
