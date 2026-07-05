# P11 Product Hardening — Operator App UX Audit

**Surface:** `public/index.html` (operator app — every surface)
**Method:** live browser drive-through (Chrome DevTools MCP) of the whole app as the
non-technical operator persona, on a freshly restarted server, logged in as
charles@agntic.co (tenant `agntic`). Distinct from the Q01–Q30 functional punch-list
([`p11-operator-punchlist.md`](p11-operator-punchlist.md)) — this pass hunts **UX
vulnerabilities**: false/ misleading copy, destructive actions without guardrails,
undiscoverable features, confusing/contradictory states, and jargon.
**Date:** 2026-07-03.

Status legend: `OPEN` (found, not yet addressed) · `FIXED` · `WONTFIX`.

## Fixed so far (branch `p11-hardening-fixes`)

| ID | Fix | Commit | Verified |
|----|-----|--------|----------|
| A1 | Onboarding test-run copy made honest (a test is a real run) | `5a4997f` | served |
| C1 | Delivery labels method-aware (SOP tab/export, review pane, cards, dashboard) | `5a4997f` | live — SOP reads "Emails the result to …" |
| R22 | `drive_create_folder` added to the googleToken injector set | `6c7c866` | live — now creates a folder |
| D1 | Two-step confirm + dependency warning before Disconnect | `4fe1d4e` | live — first click arms + warns, stays connected |
| R16 | Persist + restore typed-but-unsent new-workflow input | `88571d7` | live — survives nav + reload |
| R13 | Config validation on all writes (no empty-junk artifacts) | `80769f8` | live — empty rejects, valid works |
| B1 | `time_saved` home module on by default → ROI report discoverable | `c104b4e` | live — card + "View ROI report" show |
| R6/C3 | Previews render readable text, not raw ```html source | `f28d85e` | live — Profile outputs clean |
| SOP | Exported SOP PDF was blank (white text on default white page); switched to dark-on-white light theme | `4bbd11e` | live — user-confirmed PDF renders |

## Group (b) — behavior fixes (branch `p11-hardening-fixes-b`)

Riskier/behavioral items, done with explicit sign-off.

| ID | Fix | Commit | Verified |
|----|-----|--------|----------|
| R17 | Chat tool_use/tool_result mismatch: mid-stream text-then-tool turns now preserve `_anthropicContent` (was the leaked-400 root cause); `cleanLLMError` no longer surfaces raw SDK text | `16cdb86` | root cause traced to `builder.js:642`; syntax-clean; server restarted |
| R14 | Test verdict means *valid output* not just "ran": backend `/workflows/run` flags `ERROR:`-sentinel step outputs as `issues[]`+`clean`; frontend treats completed-with-issues as a break at the offending node and blocks publish | `4bd8ffe` | unit-verified 3 cases (clean→pass, ERROR→fail@node, throw→fail); live |
| R1/R2 | Chat asserts it builds workflows itself (identity clause) + "build it" is the ready_to_build signal, not a tool call | `4c8b9b3` | prompt fix — needs live chat round to confirm |
| R18 | Already largely addressed — converger receives real base/table/field names at session bootstrap (`builder.js:769`). Remaining gap is only a reusable helper/endpoint. | — | not a bug; noted |
| R23 | Airtable trigger dead. **Held — REQUIRED BEFORE DISTRIBUTION** (see below). | — | held |

### R23 — Airtable trigger (pre-distribution blocker)

**Held on 2026-07-04** per decision: fine for now, but this must land before Atlas is
distributed to customers who rely on Airtable triggers. Any Airtable `airtable_record_changed`
workflow published today silently never fires.

Why OAuth isn't enough: OAuth authorizes Atlas to *read/write* a base; it does **not** make
Airtable *push* events. Airtable only sends record-change events to an explicit webhook
subscription created via its Webhooks API. That subscription is per **base**, created with the
tenant's own token — so webhook objects are per (tenant, base), but the mechanism is one generic
code path. The multi-tenant plumbing already exists: workspace-level install (`wsinstall:<tenantId>`),
routing table `_webhookMap` keyed by `tenantId` (`airtable/index.js:55–79`), per-webhook HMAC.

**Two wiring jobs, not one:**
1. **Create on publish** — call `createAirtableWebhook` (helper exists, `airtable/index.js:157`;
   REST endpoint exists, `server.js:1613`) from the publish path (`builder.js` POST
   `/api/builder/workflows`, ~1384) when the spec contains an `airtable_record_changed` trigger,
   extracting baseId/tableId from the trigger config. Gate on a public `OAUTH_REDIRECT_BASE` +
   connected token; failures log, never block publish.
2. **Refresh before expiry** — Airtable webhooks expire (~7 days; `createAirtableWebhook` returns
   `expirationTime`, `airtable/index.js:171`). `refreshAirtableWebhook` (`:178`) exists but has
   **zero callers**. Needs a periodic job (scheduler 60s tick is a natural home) to refresh each
   live webhook before `expirationTime`, or re-create it if lapsed. Without this, even a correctly
   created webhook goes silently dead after a week.

**Verification requires** the public tunnel (`dev.agntic.co`) reachable by Airtable + a real
connected base with a trigger workflow — cannot be proven on localhost.

## Group (c) — remaining UX/reliability sweep (branch `p11-hardening-fixes-c`)

The rest of the open findings, done as one branch. Line numbers re-grounded live before each fix.

| ID | Fix | Commit | Verified |
|----|-----|--------|----------|
| R4 | Test-output header method-aware (was hardcoded Slack `#`+channel on email deliveries) | `3f4b045` | syntax-clean; uses existing `_deliveryMeta` |
| R6 | Already fixed by R6/C3 — `_summaryText`→`_deliveredMessage`→`_htmlToText` | — | verified in code |
| F1 | Knowledge header "Filesystem" → "Files" | `3f4b045` | live (static) |
| A2 | Skipping the welcome persists (`atlas_tutorial_done` on close) — shows once | `3f4b045` | live |
| E2 | Sidebar search hides the ephemeral draft for non-matching queries | `3f4b045` | live |
| C2 | Profile baseline empty-state reworded — no longer contradicts the estimated Time-Saved figure | `3f4b045` | live |
| R9 | Deleting a workflow removes its `atlas_build_wf_v1:*` localStorage draft | `3f4b045` | live |
| R5/R21 | Test run holds last step "firing" until engine returns + elapsed timer (no more all-✓-yet-hung) | `3f4b045` | logic verified |
| R8 | Real test-run duration persisted (frontend measures wall-clock; `startRun` accepts `startedAt`; builder backdates) | `3f4b045`,`50e4fd6` | logic verified |
| B2 | Daily Tip prompt constrained to facts; told a paused workflow consumes nothing | `50e4fd6` | prompt fix |
| R3 | HTML email formatting folds into the last content node — no redundant back-to-back LLM node | `dc16d78` | prompt fix |
| A3 | Transient ⚠ error bubbles no longer persisted into the draft (isError flag, dropped on save) | `0af4e0b`… | live |
| E1 | Deleted drafts distinguished by deletion date | `0af4e0b` | live |
| G1 | Verified already-safe — inbox empty states are mutually exclusive on `inboxSearch`; no double render possible | — | verified in code |

**Residuals (grounded, deliberately not fixed here):**
- **R10** — the ledger's step-level premise ("`airtable_list_records` returns empty-success on 429")
  is a **non-bug**: `makeAirtableApi`/`makeGoogleApi` **throw** on 429, so in-workflow steps fail
  loudly (`step_failed`). The real silent-on-throttle is the **trigger layer** — Gmail poll
  (`server.js:648-653`) swallows errors to `[]`; Airtable webhook dispatch (`server.js:330-338`)
  drops payloads with no cursor replay. Deeper reliability work, and the Airtable half overlaps the
  held **R23** (triggers don't fire at all yet). Deferred with R23.
- **R19** — prompt now instructs deliver fan-out (one node per destination), but the **gap-scorer**
  (`gap-scorer.js:26,36`) marks the spec complete after the *first* delivery node, so the loop can
  route to ratify before a second destination is proposed. The robust fix is a converger-loop change
  that needs adversary testing (protected Phase-3 loop) — flagged, not batched.
- **R15** — manual rename correctly syncs `draftName`+`spec.name`; the drift is in the converger's
  name-application during *build*. Can't pin from the frontend — needs live repro.
- **E1 (partial)** — the a11y-tree absence + first-click-feedback of the deleted flyout are
  framework-timing issues needing live repro; the label distinctiveness is fixed.

## Fix priority index (P11 hardening worklist)

All findings below are **captured for P11 product-hardening fixes** — no features were built.
Ranked by theme for the fix pass; full detail in the tables that follow.

**Tier 1 — Trust / verdict integrity (fix first; these make the app lie to the operator):**
- **R14** — test says "all passed · safe to publish" while delivering an `ERROR:` string. Make the
  verdict mean *valid output*, not just *each step ran*. (Also standardize empty-data handling — it's
  LLM-authored & inconsistent: some nodes note-gracefully, some hard-error.)
- **A1** — onboarding claims test runs are sandboxed; they hit real Gmail/Slack. Make copy honest or
  actually sandbox deliveries in test.
- **R2 / R1** — chat denies it can build ("a human team will do it") or no-ops on "build it";
  tool-mode persona confusion when connectors are active.
- **R17** — raw Anthropic API error (`tool_use_id … tool_result blocks`) leaked to the operator.

**Tier 2 — Capabilities (mostly good — see [`p11-connector-matrix.md`](p11-connector-matrix.md)):**
- **R11 & R12 RETRACTED (false)** — Slack and Google writes actually run; earlier tests used
  non-existent action IDs. 57/67 capabilities `ready=true`; Slack, Gmail, Calendar, Tasks, Docs,
  Airtable-full-CRUD, Web, Atlas-inbox all verified working as steps/deliveries.
- **R22** — the one real capability bug: `drive_create_folder` fails "no access token" while sibling
  Google writes succeed. Fix token/scope resolution.
- **Event triggers (session-6 verified):** `gmail_new_message` ✅ **fires** (poll-based, works locally);
  `airtable_record_changed` ❌ **broken — R23** (webhook registration never called → never fires, even
  in prod); `slack_message` ⚠️ wired but unverified (webhook, needs public host). These gate the
  valuable "when X happens" workflows + Discovery — **only Gmail works today.**
- **Sheets** (`sheets_read/append`) untested — no spreadsheet fixture in the tenant.
- **C1** — email deliveries mislabeled as Slack posts ("#gmail_send in Slack") in SOP + review pane +
  previews. Make delivery copy channel-aware.
- **R18** — asks the non-technical operator for a raw Airtable Base ID instead of listing bases.
- Minor: Slack posting needs the bot to be a member of the target channel (only in #history now).

**Tier 3 — Data integrity / safety:**
- **R10** — connectors silently return empty-success on throttle/quota (Airtable/Drive), and get
  stuck. Retry/back off or fail loudly. (Blocks any data-driven or discovery feature.)
- **R13** — write actions execute with no config validation → junk artifacts.
- **D1** — Disconnect fires immediately, no confirm + no dependent-workflow warning.
- **R19** — dual-delivery silently dropped (converger can't fan-out to two terminal deliveries).
- **R16** — typed workflow input lost on navigation (no autosave/warn).

**Tier 4 — Value visibility / discoverability:**
- **B1** — ROI report (the value proof) off-by-default & hidden. **R6/C3** — in-app previews show raw
  HTML (the delivered email is actually fine). **B2, C2, Q09** — contradictory/absent value numbers.

**Product opportunity (P11+ / roadmap, not a defect) — "Discovery panel" (grounded workflow suggestions):**
- **Concept (user-liked, 2026-07-04):** a panel that proposes *personalized* workflows the same way
  this audit did — by scanning the user's real connected data, detecting signals/gaps, and surfacing
  specific automations with the spec pre-filled → one-click "Build it." Lives where the blank-page
  "What would you like to automate?" is today (replaces/augments the 4 static chips), and/or a Home
  card ("3 workflows we think would help you").
- **Why it matters:** today ideation is a **blank page** — 4 static chips (one leads to dead Slack
  caps) + brainstorm-if-asked chat, nothing grounded in the user's data. The self-startable
  "digest/briefing" shape dominates because event-driven workflows are hard to imagine without live
  activity. Discovery turns the blank page into a personalized menu.
- **Proven in session-6:** one pass over Airtable/Gmail/Calendar surfaced real signals (leads stuck
  "Contacted" 4 wks, open £1,750 invoice, unanswered client threads) → 6 concrete workflow ideas,
  **3 fully runnable today**, each tagged with the observed signal + capability status.
- **Must-haves:** (1) **capability-aware** — only suggest workflows that actually run (the current
  static Slack chip already violates this, R11); tag each suggestion runnable/needs-trigger/dead.
  (2) Depends on **R10 fixed** (empty-on-throttle reads → discovery would show nothing, as it did
  live) and **event triggers verified** (Gmail-new-message, Airtable-record-changed — untested;
  they gate the *valuable* half of the suggestions).
- **Double win:** solves the operator's blank-page problem *and* the internal "hard to invent complex
  workflows to demo/test" problem.

## Ranked findings

| ID | Sev | Surface | Summary | Evidence | Status |
|----|-----|---------|---------|----------|--------|
| UX-A1 | **HIGH** | onboarding | **False safety promise:** welcome step 4 says *"Test runs are sandboxed — nothing is sent to real channels or inboxes during a test."* This is untrue — "Run test" executes the real spec against the real engine (`runTest()` → `POST /workflows/run`), and the test panel itself says "run against the **real engine**". Observed live: a test run read real Gmail and called the real Slack `chat.postMessage` API (only failed on `channel_not_found`, a real API response). A user could send a real email / Slack message believing it's a dry run. | Onboarding step 4 copy; `public/index.html` `runTest()` (`fetch("/workflows/run", …)`); observed test run hit real Gmail + Slack. | OPEN |
| UX-C1 | **HIGH** | console · SOP | **Customer-facing SOP misdescribes delivery.** The SOP tab hardcodes every delivery step as *"Posts the result to #general in Slack"* and labels the raw action id as the channel. For the AI Morning Briefing's **email** delivery (`gmail_send` to Charles) it renders "Posts the result to #general in Slack" + "Channel: gmail_send" — wrong method and wrong destination. The SOP **tab** and the SOP **export** also disagree (export says "Sends the processed output to gmail_send"). Distinct from Q03 (which only fixed `connector-action` nodes). | `public/index.html:4203` (`"Posts the result to " + this._slackChannel() + " in Slack."`), `:4221-4224` (defaults channel to `#general`); backend `src/workflows/sop-generator.js:112-115`. | OPEN |
| UX-D1 | **HIGH** | connections | **Destructive action, no guardrail.** The connector detail modal's "Disconnect" fires `DELETE /connectors/<provider>` **immediately** — no confirmation dialog and no warning that active workflows depend on it. One misclick silently breaks any workflow using that connector on its next run (disconnecting Airtable breaks the Airtable campaign; disconnecting Google breaks the Morning Briefing's email delivery). The only feedback is a flash "disconnected — you can reconnect anytime", which understates the impact. | `public/index.html:4675` (`onDisconnect` → no confirm), `disconnectProvider` `:3410-3421` (direct DELETE). | OPEN |
| UX-B1 | MODERATE | home · account | **Customer-facing ROI report is undiscoverable.** The all-up ROI report (Q08 deliverable) has exactly one entry point: the Home "time saved" card's `View ROI report →`. That card is gated by `hmTimeSaved` = the **"Time Saved" homepage module**, which is **OFF by default** (verified in Account settings) *and* additionally requires measurable time-saved (≈0 for the 24/25 workflows with no baseline). So out-of-the-box there is no path to the ROI report. | `public/index.html:760` (`sc-if hmTimeSaved`), `:4945` (`includes('time_saved')`), `openRoi()` `:2496`; Account→Homepage "Time Saved" toggle off by default. | OPEN |
| UX-C2 | MODERATE | console · Profile | **Contradictory time-saved copy.** The Profile shows **"TIME SAVED YTD: 24m"** at the top while simultaneously showing **"BASELINE: Not set"** and a card *"Set a baseline to track time saved"* (implying nothing is tracked). The 24m is the flat estimate (Q09); the two messages contradict each other. | Profile tab: `TIME SAVED YTD 24m` vs `BASELINE Not set` + "Set a baseline to track time saved" rendered together. | OPEN |
| UX-C3 | MODERATE | console · Profile | **Raw HTML shown as output.** "RECENT OUTPUTS" render the run output verbatim — raw HTML source with ` ```html ` markdown fences and inline CSS — instead of rendered/readable content. The operator sees a wall of `<div style="…">` code. (Same root as the P10+ "delivery formatting" gotcha, surfacing in the Profile view.) | Profile "RECENT OUTPUTS" show ` ```html <div style="font-family:…"> …`. | OPEN |
| UX-A2 | MODERATE | onboarding | **Welcome modal nags every reload.** "Skip for now" does not persist — the full-screen 6-step welcome re-appears on *every* page reload/session. Only completing to step 6 and ticking "Don't show again" persists dismissal (verified). A returning user who skips is re-interrupted each load. | Observed: modal re-shown on ~5 consecutive reloads after "Skip for now"; suppressed only after step-6 checkbox. | OPEN |
| UX-A3 | MINOR | builder | On load the app restores the last draft into the builder **including a stale error** ("⚠ The connection dropped…") from a previously abandoned attempt — a returning user is greeted by an old error message as the landing view. | Reloads landed on the prior Q05 dropped-stream error bubble (localStorage draft recovery). | OPEN |
| UX-B2 | MINOR | home | **Misleading Daily Tip.** The AI-generated tip states "paused workflows consume resources without providing value" — a paused workflow does not run and does not consume resources; the advice is factually off. | Home Daily Tip copy. | OPEN |
| UX-E1 | MINOR | sidebar | "Recently Deleted" first click gave no visible feedback (panel opened only on a later interaction) and the flyout is absent from the accessibility tree (screen-reader gap). Deleted drafts all display as identical "New workflow / 30d left" with no timestamp/content — indistinguishable. | `public/index.html:142` (`onToggleDeletedFolder`), `:1546` flyout; observed no a11y node + identical labels. | OPEN |
| UX-E2 | MINOR | sidebar | Sidebar search leaves the current ephemeral "New workflow" draft visible regardless of the query (searching "Airtable" still shows "New workflow"). | Observed: search "Airtable" → list = New workflow + Airtable campaign. | OPEN |
| UX-F1 | MINOR | knowledge | Header reads **"Filesystem"** — developer jargon for a non-technical operator audience (the P4 persona). "Files"/"Documents" would read better. Also: browser "Connect folder" cannot grant a server-usable absolute path (browser uploads are RAG-only per the build notes), so the affordance may not do what a user expects. | Knowledge view header "Filesystem"; build note on upload-vs-absolute-path folders. | OPEN |
| UX-G1 | MINOR | inbox | Empty Inbox shows two empty states at once: "No results found" (search-empty) under a "RESULT" header **and** "No messages yet." under "MESSAGES" — redundant/confusing when no search has been entered. | Inbox empty state renders both blocks simultaneously. | OPEN |

## Worked well (no defect)

- **Onboarding structure** — Back nav (from step 2), Skip on every step, distinct
  "Get started" final button, "Don't show again" persistence.
- **Homepage customization** — Account→Homepage module toggles are a nice touch.
- **Console live poll** (Q01) and **run drawer states** (Q12) behave correctly.
- **Recently Deleted** provides per-item **Recover** and a clear "removed after 30 days".
- **Sidebar search** filters real workflows correctly; **empty Connections** state (Q19) is clean.

## Real-user drive-through (session 2, 2026-07-03)

Operating the app end-to-end as a real user would — building workflows, chatting,
running/verifying them. New findings appended here with `UX-R#` ids as they surface.

| ID | Sev | Surface | Summary | Evidence | Status |
|----|-----|---------|---------|----------|--------|
| UX-R1 | **HIGH** | builder chat | **"Build it" produces nothing + hallucinated actions.** Building workflow #1 (EV news → email), after 2 clarifying Qs I said "go ahead and build it." Atlas replied *"On it! I'll run a test now… here's your first EV briefing while I get the daily schedule set up"* — but no "Build it →" CTA rendered, no build started, Test panel stayed "Not started." The chat promised actions it can't take from chat and stranded the user (said build → nothing built). Tool-mode flakiness: model returns prose instead of `ready_to_build:true`. Recurring; blocks the primary flow. | Live workflow #1; reply had no CTA; `src/api/builder.js` chat tool-mode (connected tools → prose, see CLAUDE.md "parsed:false when tools active"). | OPEN |

| UX-R2 | **HIGH** | builder chat | **Atlas denies its own core function + invents a human team.** When pushed ("nothing happened, actually build it"), Atlas replied: *"I can't actually schedule a recurring daily workflow on my own. That requires building a Flow, which **a human on the Agntic team would set up for you**… I'll **flag this conversation so the team knows to build** the daily 7am schedule."* Categorically false — Atlas IS the builder; there is no human team and nothing gets "flagged." The chat model (connector tools active) adopts an escalate-to-humans assistant persona and tells the customer the product can't do its core job. Trust-destroying. (The "Build it →" CTA did render on this turn — inconsistent with UX-R1's prior turn.) | Live workflow #1 turn 4; system prompt / tool-mode in `src/api/builder.js buildChatSystem`/`buildChatTools`. | OPEN |

| UX-R3 | MINOR | builder | **Redundant LLM formatting node.** For the EV-briefing build the converger added *two* consecutive LLM nodes: "Compile EV Briefing" (whose prompt already outputs email-ready HTML `<h2>/<p>/<h3>`) **and** a separate "Format Briefing as HTML Email" that re-formats the already-HTML content. Extra LLM call = extra cost + latency for redundant work. (Seen repeatedly — the converger reflexively inserts an HTML-format node before `gmail_send`.) | Live workflow #1 steps 3 & 4. | OPEN |
| UX-R4 | MINOR | builder · test | Email delivery step is labeled **"#gmail_send"** in the test panel — the `#` Slack-channel glyph + raw action id on an email delivery (same family as UX-C1). | Live test panel deliver row "# #gmail_send". | OPEN |
| UX-R5 | MODERATE | builder · test | **Optimistic test animation runs ~40s ahead of the engine.** During the test run all 5 steps showed "✓ Fired" checkmarks while the panel stayed in a disabled "Testing… / Running each step in order…" state with a spinner and a "will appear here" output placeholder — for ~40s it looked finished-yet-hung. It did eventually resolve to "All steps passed", but the gap (steps visibly ✓ but state still "Testing…", button disabled) reads as a hang. | Live workflow #1 test run; all steps ✓ ~40s before `testState` flipped to passed. | OPEN |
| UX-R6 | MODERATE | builder · test | **Test-output preview shows raw HTML.** The "TEST OUTPUT" panel — explicitly the "see what the delivered message looks like" preview — renders the email as raw ` ```html <div style="…"> ` source, not a rendered preview. Defeats the purpose of a pre-publish preview. (Same root as UX-C3, but this is the dedicated preview surface.) | Live test "TEST OUTPUT" = ` ```html <div style=…>Your Daily EV Briefing…`. | OPEN |

| UX-R8 | MINOR | console | After publishing workflow #1, its persisted **test run shows "1ms · 4 steps"** in run history, but the actual test executed 5 steps over ~40s and delivered a real email. The saved testRun metadata (duration/step-count) is wrong. | Live console "Daily EV News Briefing" run history row. | OPEN |

### Connector-combination testing (session 3) — via real engine (`POST /workflows/run`)

Fired crafted specs through the real engine to exercise connector capabilities in combination.
**Works ✓:** web_search, web_fetch, gmail_search, calendar_list_events, drive_list_files,
airtable_list_records, airtable_search_records, summarize, rewrite, llm, docs_create, airtable_create_record, in_app(inbox).

| ID | Sev | Surface | Summary | Evidence | Status |
|----|-----|---------|---------|----------|--------|
| UX-R11 | ~~HIGH~~ **RETRACTED — FALSE** | connectors · slack | **CORRECTION (session-6, clean retest): Slack works.** The original finding tested wrong action IDs (`post_message`, `list_channels`) — raw Slack API method names mis-grepped from the catalog file, not real capability IDs. The actual catalog IDs are `slack` (post), `slack_dm`, `slack_history`, `slack_list_channels`, `slack_get_workspace_info`, `slack_list_users`, etc. Retested: **all run** — `slack` posted a real message (`delivered:true`, real `ts`) to #history, `slack_history` read it back. Config keys: **`target`** (channel), **`user`** (DM ID/email). The earlier `channel_not_found` on Slack *delivery* was **not a bug** — the bot is only a member of `#history` (all other channels `is_member:false`), so posting elsewhere needs the bot invited/joined first. Minor real issue: standalone `slack` post uses piped input as the body (posts `{}` if no upstream) — fine in a real workflow. **Net: Slack is usable; original R11 is withdrawn.** | Session-6 retest via `/workflows/run` action=`slack`/`slack_history`/etc. with `target`. | RESOLVED (false) |
| ~~UX-R11-orig~~ | — | connectors · slack | (superseded — original text below kept for provenance) **Every Slack connector-action is UNWIRED.** The capability catalog advertises ~40 Slack capabilities (`post_message`, `list_channels`, `get_channel_history`, `list_users`, `post_dm`, `reply_in_thread`, `add_reaction`, `search_messages`, `create_channel`, …) but **all** return `"Connector action \"X\" is not available in this build."` when run as a connector-action step. Only the `deliver`-node Slack path calls `chat.postMessage` (and that fails `channel_not_found` for the bot's non-member channels). So the converger can propose Slack *steps* that will always fail, and Slack is effectively unusable except as a delivery to a channel the bot is already in. | `POST /workflows/run` with `connector-action` action=`post_message`/`list_channels`/etc → all "not available in this build". | OPEN |
| UX-R12 | ~~MODERATE~~ **RETRACTED — FALSE** | connectors · google | **CORRECTION (session-6 clean retest, see [`p11-connector-matrix.md`](p11-connector-matrix.md)):** the IDs in the original finding (`sheets_update`, `docs_append`, `gmail_create_draft`, `drive_get_file`, `drive_create_file`) **are not real catalog capabilities** (mis-grepped API method names). The actual Google write capabilities run: `docs_create` ✅, `calendar_create_event` ✅, `tasks_create` ✅, `gmail_send` ✅. The **one** real Google write issue is `drive_create_folder` → UX-R22. Original R12 withdrawn. | Session-6 retest of correct catalog IDs. | RESOLVED (false) |
| UX-R23 | **HIGH** | connectors · airtable · triggers | **`airtable_record_changed` trigger never fires — orphaned webhook registration.** The per-base Airtable webhook is created via `POST /connectors/airtable/webhooks`, but **no code anywhere calls it** (not the UI publish path, not the backend `workflowService.create` — only the README references it). So publishing a workflow with an Airtable trigger yields an `active` flow with **zero webhook subscription** → it can never fire, even in production. (Separately, the notificationUrl defaults to `localhost` unless `OAUTH_REDIRECT_BASE` is set, so it also needs a public HTTPS host.) Verified live: published an airtable-trigger workflow → `memory/airtable-webhooks.json` stayed empty, no registration events. Contrast: the **Gmail** trigger (poll-based) **verified firing end-to-end**. | Session-6: repo-wide grep shows the endpoint is never invoked; live publish registered nothing. | OPEN |
| UX-R22 | MODERATE | connectors · google | **`drive_create_folder` fails "no access token".** Returns *"google: no access token — connect Google via /connectors/google/authorize"* while sibling Google writes on the **same** grant (`docs_create`, `calendar_create_event`, `tasks_create`) succeed seconds earlier. Token-resolution bug or missing Drive-folder scope in that specific handler. | Session-6 `/workflows/run` action=`drive_create_folder`. | OPEN |
| UX-R10 | **MODERATE** | connectors · airtable | **Silent empty-on-throttle.** Under rapid reads the Airtable connector hits HTTP 429; on the throttled calls it returns `completed:true` with an **empty record set and no error** (only a severe throttle finally surfaces the 429). An Airtable-reading workflow that gets rate-limited would silently emit "0 records" as if the data were empty — data-integrity risk with no signal to the user. Should retry/backoff or fail loudly, not return empty-success. | 6 sequential `airtable_list_records`: 5×`{completed:true,count:0}` then `HTTP 429`; same query returned 3 real records when unthrottled. | OPEN |
| UX-R13 | MODERATE | connectors · writes | **Write actions execute with no config validation → junk artifacts.** `docs_create` and `airtable_create_record` returned `completed:true` when called with **no/garbage config** (no title/content/fields), creating empty artifacts in the real Google Drive / Airtable base. Write capabilities should validate required config before executing. | `/workflows/run` action=`docs_create` / `airtable_create_record` with only stray `baseId/tableId` → completed. | OPEN |

**R10 scope note:** the silent-empty-on-throttle affects **both Airtable (429) and Google Drive
(quota)** under rapid calls — `drive_list_files` and `airtable_list_records` returned
`completed:true, count:0, no error` while un-throttled connectors (`gmail_search`, `web_search`,
`web_fetch`) kept working in the same window. So it's a general OAuth-connector pattern, not
Airtable-specific.

**⚠ Artifacts created during R13 probing (need cleanup):** one likely **empty Airtable record**
in base `appiJz0lZ1DJtVrAU` / table `tblVbidmBZuBt1Tkf`, and one likely **"Untitled document"**
Google Doc in Charles's Drive. Couldn't verify/delete them live because the reads were
throttle-empty (R10), and there is no wired `drive_delete`/trash action (R12) to remove the Doc
via a workflow anyway. **Action: once throttles reset, list the base + Drive and delete the empty
record / untitled doc** (the doc must be trashed manually in Google Drive).
| UX-R9 | MINOR | builder | **Orphaned localStorage.** Deleted workflows leave `atlas_build_wf_v1:<tenant>:<email>:<id>` draft keys in localStorage forever (8+ stale keys for already-deleted drafts observed). Never garbage-collected. | `localStorage` keys after deleting drafts. | OPEN |

### Session 5 — complex workflow + navigation data-loss

| ID | Sev | Surface | Summary | Evidence | Status |
|----|-----|---------|---------|----------|--------|
| UX-R16 | MODERATE | builder | **Typed-but-unsent workflow input is silently discarded on navigation.** A new workflow with a long typed description (not yet submitted) was lost the instant the user clicked elsewhere — no `/chat` or `/draft` POST ever fired (event log), no autosave of the input text, no "discard changes?" prompt, no recovery. Distinct from Q22 (which *intentionally* discards *empty* ephemerals) — here substantial composed content vanished. A user mid-compose who mis-clicks loses their work. Should preserve/warn when the input is non-empty. | Live: typed a multi-paragraph brief in a new workflow, navigation discarded it; no POST in `memory/logs/atlas-events.log` after the click. | OPEN |

| UX-R17 | **HIGH** | builder chat | **Raw Anthropic API error leaked to the operator.** On the complex multi-source request, the chat's tool-mode "let me pull data right now" hallucination corrupted its own message history, and the raw provider error surfaced verbatim in the chat: *"⚠ messages.2.content.0: unexpected tool_use_id found in tool_result blocks: toolu_01Awu… Each tool_result block must have a corresponding tool_use block in the previous message."* Incomprehensible/alarming to a non-technical operator; also proves the tool-mode path can desync `tool_use`/`tool_result` blocks. | Live session-5 complex build, 2nd turn. | OPEN |
| UX-R18 | MODERATE | builder chat | **Asks the non-technical operator for a raw Airtable Base ID.** The (good) recovery plan then asked *"What's your Airtable Base ID and table name? (e.g. appXXXXX / \"Leads\")"* — a technical value the target persona won't know, when the app already holds the Airtable OAuth connection and could list bases/tables itself. A real user would be blocked here. | Live session-5: converger clarifying Q for Airtable base/table id. | OPEN |

| UX-R19 | **MODERATE** | builder | **Dual-delivery silently dropped.** The complex "Weekly Business Briefing" explicitly requested (and the plan explicitly listed as "Step 6") *email the report AND save a copy as a Google Doc*. The actual build produced only the email — **no Google Doc / second-delivery node** (spec: 6 nodes ending at one `deliver_email`, no `docs_create`). The converger builds a single linear chain and can't fan-out to two terminal deliveries, so it silently omitted a confirmed requirement. User believes they have a Doc archive; they don't. | Live session-5 spec `9586157d`: nodes end at `deliver_email`, no docs node; plan step 6 was "Save a Google Doc." | OPEN |
| UX-R21 | MINOR | builder · test | **Very long runs look hung.** The complex workflow test took **~3.5 min** (web search ~67s + 3-source synthesis ~63s), but the optimistic step animation showed all steps ✓ within ~30s and then sat in a disabled "Testing… / Running each step…" spinner with a placeholder output for ~3 min. No elapsed timer, no real per-step progress, no timeout messaging — reads as hung. (Extends UX-R5.) | Live session-5: run.start 5:55:01 → run.ok 5:58:25 in event log; UI "Testing…" the whole time. | OPEN |

**Complex-workflow result (session 5) — the value verdict holds under complexity.** A 6-step,
3-source **fan-in** ("Weekly Business Briefing": Airtable leads + Gmail + web → synthesize → format
→ email) built entirely by talking, ran end-to-end, and **delivered a genuinely useful briefing**
(accurate real "Top Priorities" incl. a real client/pricing follow-up) — **even with the Airtable
source throttled-empty**, because the synthesis prompt was authored to note missing sources
gracefully. Positives proven: multi-source fan-in works via explicit `{{node.output}}` refs +
transitive threading (despite linear-chain edges); robust to a degraded source; email renders
properly. Caveats: dropped Google Doc (R19), ~3.5-min runtime looked hung (R21), and R17's chat
tool-mode actually executed a live Airtable call with the *placeholder* base `appXXXXXXXXXXXXXX`
(its own example) → "Invalid permissions" → 400 desync. Empty-data handling remains **LLM-authored
and inconsistent** (this synthesis node = graceful; the sibling format node = hard `ERROR:` guard →
still latent R14).

### Session 4 — visible UI drive-through (real-user, human pace)

| ID | Sev | Surface | Summary | Evidence | Status |
|----|-----|---------|---------|----------|--------|
| UX-R14 | **HIGH** | builder · test | **Test reports "all steps passed / safe to publish" while the workflow actually delivered an ERROR string.** Built a Gmail→summarize→format→email digest and ran the test. The Gmail search matched no "important unread" emails (a normal case), so the LLM nodes' empty-data guard fired and emitted the literal `ERROR: required data not found`; the deliver step **emailed that error string to Charles**. Yet the test panel showed every step **"Passed"**, "Every step ran cleanly — no breaks", **"safe to publish"**, and the chat said it *"ran perfectly… without any hiccups."* The gate's success = "each step completed without throwing", not "produced valid output" — so it greenlights a workflow that ships error text. Real users would publish it and get `ERROR: …` emails whenever upstream data is empty (common). Compounds with R10 (empty-on-throttle → same failure mode). | Live session-4 test run; TEST OUTPUT = "ERROR: required data not found" under a green "All steps passed / safe to publish" verdict + a real error-email sent. | OPEN |
| UX-R15 | MINOR | builder | **Workflow name drifts between steps.** The name node confirmed "**Daily** Morning Email Digest"; the test panel titled it "**Weekday** Morning Email Digest". The derived/displayed name differs from the confirmed one. | Session-4 build: name node vs test-panel title. | OPEN |

**Session 4 note (positive):** with a fully-specified request that ends in "please build it," the converger went **straight to a plan + "Build it →" CTA on the first message** (no clarifying loop, no R1/R2 "human team" derail) — so R1/R2 are triggered by ambiguity + Slack-tool context, not the happy path. The 5-step build flowed cleanly; every step "completed". The failure is the **semantic** one (R14): completion ≠ correctness.

## VALUE ASSESSMENT — is the program's actual value being realized? (2026-07-04)

Operated as a real operator automating real work. **Verdict: the core value is real and
demonstrably delivered on the happy path — but the program cannot reliably tell, or tell the
user, whether it succeeded, and several connector paths are dead. That trust/reliability gap is
what stands between "impressive" and "dependable."**

**Value IS realized (evidence):**
- End-to-end conversational build works: describe → clarify → propose each step → test → publish.
- The engine reliably executes schedule/web/gmail → summarize/llm → email combinations.
- **Genuinely useful output.** The "Morning Email Digest" read Charles's *real* inbox and produced
  an accurate, actionable exec summary — "13 emails / 6 topics / 3 need attention," with correct
  specifics (a real BD contact + a real Stripe invoice #/amount/due-date). That is exactly the
  promised value.
- **Delivered emails render correctly.** `gmailSend` (`src/connectors/google/index.js:311`) strips
  ` ```html ` fences, sets `Content-Type: text/html`, and wraps content in a styled shell — so the
  recipient gets a clean formatted email, not tag-soup. (Updates the CLAUDE.md "raw tags" gotcha:
  fixed for the gmail_send path.)

**Value is UNDERMINED by (ranked):**
1. **R14 — can't distinguish success from failure.** Empty upstream data (a *common* case) →
   delivers `ERROR: …` while showing "all steps passed / safe to publish / ran perfectly." The
   operator can't trust the green light.
2. **R11/R12 — dead connector capabilities.** All Slack steps + several Google writes are unwired,
   yet advertised and even *suggested* by the chat.
3. **R10 — silent empty-on-throttle** (observed to persist/stick), so data-driven workflows can
   silently emit empty/error output.
4. **R2/R1 — chat sometimes denies it can build** ("a human team will do it") or no-ops on "build it."
5. **Value is mis-communicated both ways:** working output *looks* broken in-app (raw-HTML previews,
   UX-R6/C3 — preview-only, the real email is fine) and email deliveries are mislabeled as Slack
   (C1); meanwhile the ROI/time-saved report that would *prove* value is off-by-default & hidden
   (B1) and shows contradictory numbers (C2/Q09).

**Bottom line for a non-technical operator:** when it works, it delivers the promise (a real,
accurate morning digest is worth the subscription). But they must trust green checkmarks they
can't verify — and those checkmarks lie on the most common failure case (empty data). Fix R14
(verdict = valid output, not just "ran"), wire or hide the dead connectors (R11/R12), and make the
delivered value visible/trustworthy (R6 preview fidelity, B1 ROI surface), and the realized value
matches the impressive demo.

### What worked well (session 2)

- **Full happy-path lifecycle works.** Built "Daily EV News Briefing" (schedule → web search →
  compile → format → email) entirely by talking; the test ran all 5 steps green and **delivered a
  real email** (msg id `19f2b7d5…`); publish put it live in the console as an active scheduled workflow.
- **Conversational elicitation is good** — natural one-question-at-a-time clarifying (time of day,
  depth) before building.
- **Pure "just chat" mode is excellent** — asked "what can you automate?" and got a warm, accurate,
  categorized overview that correctly referenced the tenant's actual connected tools and invited a
  follow-up. No hallucinated human-team claim here → confirms R1/R2 are specific to the **build
  handoff**, not chat in general.

### Session 2 summary

The engine + build + test + publish pipeline genuinely works end-to-end for a standard
schedule→process→email workflow. The friction is almost entirely in the **chat/converger layer**:
getting from "build it" to an actual build (R1/R2, tool-mode persona confusion) is the biggest
real-user blocker, followed by the pervasive **deliver-is-always-Slack** mislabeling (UX-C1, seen in
SOP + review pane + "what your team sees" preview + test panel) and **raw-HTML output previews**
(UX-C3/R6). Test artifacts created this session were cleaned up (EV briefing paused/removed, empty
drafts deleted).

## Notes

- Severity is UX impact for the non-technical operator persona, not code effort.
- The three HIGH items each have a concrete failure mode: UX-A1 can cause an
  *unintended real send* (worst — a broken safety promise); UX-C1 ships a wrong SOP to
  a customer; UX-D1 lets a misclick silently break live automations. Recommend those first.
- Not audited this pass: the standalone **admin app** (`src/admin/index.html`).

## Session 7 — release-confidence drive-through (2026-07-04)

Live Chrome drive as a non-technical operator, on the post-group-c build. Focus: does the core
flow actually work end-to-end, and where would a real user get stuck. New ids `S7-*`.

**HIGH — the two findings that most affect release confidence:**

| ID | Sev | Summary |
|----|-----|---------|
| S7-9 | **HIGH** | Converger builds an **unrunnable array-splat reference**. On "summarize my unread emails" it added a "Fetch Full Email Contents" connector-action referencing `{{search_unread_emails.results[*].id}}`. The engine doesn't resolve `[*]` splat, so the literal string hit the Gmail API → "Invalid id value" → whole workflow fails on first run. Common shape (search → fetch-each-item → process). The converger also *over-added* the fetch step; a simpler search→summarize→deliver would have run. |
| S7-10 | **HIGH / blocker** | **Self-repair "remove the step" does not remove the node.** After S7-9 I asked chat to "remove that step and summarize directly from the search results." Chat agreed, proposed a replacement, I confirmed, panel returned to "Ready to test" — but the DAG still showed the fetch step, and re-test hit the **identical** break. The natural recovery path from a broken build is a dead end for a non-technical user. Root: applyProposal adds nodes/edges but replace/remove doesn't delete the old node (same node-management weakness as R19). |

**MODERATE / MINOR:**

| ID | Sev | Summary |
|----|-----|---------|
| S7-2 | MODERATE | `web_search`/connector-action **times out at 180s** → run fails, workflow flips to "error" (seen live on AI Morning Briefing). Web-search workflows are a headline use case; needs longer/configurable timeout, partial-result fallback, or retry. |
| S7-5 | MINOR | SOP still shows **"Channel: gmail_send"** (raw action id) + "#" glyph on an email deliver, even though the sentence ("Emails the result to …") is correct (C1). Technical leakage in a customer-facing doc. |
| S7-3 | MINOR | Console **DAG deliver-node uses "#" glyph** for email delivery (C1/R4 family; detail text is right). |
| S7-6 | MINOR | Ephemeral **"New workflow"/"Untitled" drafts accumulate** in the sidebar (3+), never cleaned up. |
| S7-7 | MINOR | **R15 live repro**: auto-name "Daily Unread Email Digest" while the trigger is **weekdays-only**. |
| S7-8 | NOTE | Test panel stays **"Incomplete" the entire build** until the final name is confirmed; no positive progress signal during a ~6-step build (a "4 of 5 confirmed" indicator would reassure). |
| S7-1 | NOTE | A restored mid-build draft shows chat copy "ready to test" while the panel (correctly) shows "Incomplete" briefly — copy over-claims vs the gate. |
| S7-4 | POLISH | Pre-R8 TEST runs still show bogus "1ms · 3 steps" in run history (old rows; not a regression). |
| S7-11 | MINOR | Clicking sidebar **"Knowledge" during an active build did nothing** (Connections opened fine from the same state) — possible click-target/nav-suppression issue. |

**WORKED WELL (release positives):**
- **R14 verdict integrity is solid** — the broken run showed "Break found", marked the failing step, kept downstream "Queued", and gave a genuinely clear non-technical explanation. It did NOT false-pass. This is exactly right.
- **R1/R2 build flow** reproduced cleanly; confirm-each-step with plain-language rationales is strong.
- **Self-repair diagnosis** (the words) was accurate and reassuring — the gap is only that it doesn't actually mutate the spec (S7-10).
- **Console + SOP** are professional; error messages are descriptive ("timed out after 180s", "Invalid id value").
- **A3 holding** — reload restored the broken draft with no stale ⚠ error bubble.
- **F1** — Knowledge header reads "Files".

**Release read:** the surrounding product (build UX, verdict honesty, console, SOP, error messaging)
is in good shape. The gating risk is the **converger↔engine contract**: it can emit specs the engine
can't run (S7-9) and the self-repair loop can't actually fix them (S7-10). Both point at the same
converger node-management/reference-resolution weakness (R19 family). That pair should be the
pre-release priority — a non-technical user who builds a common workflow can hit a break with no way out.

### Session 7 fixes (branch `p11-hardening-fixes-d`, 2026-07-04)

All S7 findings fixed + verified. The two HIGH items were verified **end-to-end in Chrome**.

| ID | Fix | Verified |
|----|-----|----------|
| S7-9 | Converger: forbid array-splat/field-path refs + per-item "fetch each" loops (engine has no iteration); validator flags unsupported `{{…[*]…}}` as BAD_TEMPLATE_REF at build time. | unit + live (rebuilt digest runs clean) |
| S7-10 | Self-repair removal now works: `applyProposal` gets `remove_node` (rewires the chain) + `remove_edge`; converger prompt gains the remove vocabulary; edit-change path instructed to delete + a server guard drops dangling edges. | **live — asked to remove the fetch step → node deleted, chain rewired (5→4 steps), test PASSED** |
| S7-12 | Restored/dead-session drafts: stop persisting `threadId`, always null it on restore, and route free-text edits (no live session + complete spec) to the spec-based edit-change path instead of a dead converger session / generic chat. | live (surfaced + fixed during S7-10 verify) |
| S7-2 | Slow external steps (connector-action/fetch/web) get a 300s timeout backstop (was 180s). | code |
| S7-3/S7-5 | Method-aware deliver glyph in DAGs + SOP shows "Delivery: Email / To: …" not "Channel: gmail_send". | live (TEST OUTPUT shows "⬤ Atlas Inbox") |
| S7-6 | Sidebar shows a draft's original intent instead of identical "New workflow" placeholders. | code |
| S7-7 | Name proposal must match the confirmed trigger cadence (no "Daily" for weekday-only). | code |
| S7-8 | Test panel shows "Building · N steps" during a build, not a flat "Incomplete". | **live** |
| S7-4 | Run history shows "—" for pre-R8 bogus ~1ms test rows. | code |
| S7-11 | Not a bug — Knowledge nav works (earlier no-op was a click during an active build). F1 "Files" header confirmed live. | live |

**P3 converger gate re-verified green** after the prompt/spec-assembler/validator changes.

## Session 8 — operator "day-to-day use" + value read (2026-07-04)

Ran the full loop as a real operator: built "Daily Unread Email Digest", tested, recovered from a
break, **published it live**, ran it for real, and went looking for the payoff in the Inbox.

| ID | Sev | Finding |
|----|-----|---------|
| S8-1 | **HIGH — value-breaking** | **Atlas Inbox delivery is a silent no-op.** The converger emitted `deliver.channel:"in_app"`, whose handler (`channel-handlers.js:~33`, "Nothing extra needs to happen here") returns `{delivered:true}` but NEVER writes to `inboxStore`. The `/inbox` UI reads only `inboxStore` → `inbox_messages` has **0 rows** after a passing TEST run AND a passing real "Run now". Runs report 100% success and the test panel shows the digest (rendered from run output, not the store), so it *looks* delivered — but the operator's Inbox is permanently empty. The REAL inbox capability `inbox_deliver` (`src/inbox/index.js`) writes to the store correctly, but the converger picked the no-op `in_app` instead (both are offered — `prompts.js:33` documents `inbox_deliver`, `:229` also lists `in_app`). Fix: converger must emit `inbox_deliver` for the Atlas Inbox (drop/deprecate `in_app`), and/or map `in_app`→`inbox_deliver` at the delivery layer so already-published workflows work. This is the zero-setup default delivery a non-technical operator naturally picks — so the headline "build an automation by talking" loop currently ends in nothing arriving. |
| S8-2 | MINOR | **G1 double-empty-state reproduces LIVE** (my group-c "verified safe" static read was wrong — should have tested live). Empty Inbox shows "No results found / RESULT" AND "No messages yet / MESSAGES" simultaneously. |

**Value note:** external deliveries (Slack post, Gmail send) were verified working in earlier sessions;
it's specifically the in-app Inbox channel that's broken (S8-1).

### Session 8b — one-off setup actions + Slack (operator test, 2026-07-04)

Tested exactly the ask: can the agent perform one-off actions a workflow depends on (e.g. create a
Slack channel that doesn't exist)? Built "post a daily message to #atlas-standup" where the channel
does not exist.

| ID | Sev | Finding |
|----|-----|---------|
| S8-4 | **HIGH** | **The one-off setup action fails to execute (400).** When asked, the converger DOES propose it ("Setup: create_channel 'atlas-standup'" with a "Create it now" button) — good. But clicking it returns `POST /api/builder/sessions/:id/setup → 400 "Capability not found: create_channel"`. Root cause: **capability-id mismatch.** The converger proposes `capabilityId:"create_channel"` (the id in `slack/capabilities.json:72`), but the runtime capability is registered as **`slack_create_channel`** (`slack/index.js:367`), and the setup endpoint resolves via `registry.getHandler(capabilityId)` (`builder.js:946`) → no match → 400. So the channel is never created and the workflow stays broken. (Contrast: `drive_create_folder` is registered and proposed under the SAME id, so folder-creation would work — the bug is specific to Slack's `create_channel` vs `slack_create_channel` namespacing.) Fix: make the converger's action-list ids and the registry ids agree (expose `slack_*` ids to the converger, or alias `create_channel`→`slack_create_channel` in the setup resolver). |
| S8-3 | MODERATE | **Setup actions aren't offered PROACTIVELY.** The converger built the whole workflow posting to `#atlas-standup` without ever checking that the channel exists, so it produced a broken spec; it only proposed the create-channel setup after I explicitly asked (or the test broke). It should detect a named-but-missing channel/folder during the build (it already lists channels via `slack_list_channels`) and proactively offer to create it — same for Drive folders. |
| S8-5 | MINOR | **Break mis-attributed to the wrong step.** The Slack post failed (`channel_not_found` on the DELIVER step), but the test panel put the ✕ "Break" on the preceding LLM node and marked DELIVER "Queued" (failIndex off-by-one). The plain-language explanation was correct ("couldn't find the #atlas-standup channel"); only the visual marker is on the wrong node. |

**Slack positives (verified live):** the converger builds a clean Slack flow (schedule → LLM with proper
Slack **mrkdwn** formatting → deliver), the name correctly reads "Weekday" (S7-7 holding), R14 caught the
`channel_not_found` honestly with a clear human explanation, and the setup-action proposal UI ("Create
it now" / "Skip") renders well. The gap is purely that the create-channel action **400s on execute** (S8-4)
and isn't offered proactively (S8-3).

### Session 8b fixes (branch `p11-hardening-fixes-e`, 2026-07-04)

| ID | Fix | Verified |
|----|-----|----------|
| S8-4 | Setup endpoint resolves capability-id variants (raw → Slack `channelIdForCapability` bridge → connector-prefixed → registry suffix match) + prompt reinforced to copy the exact id. | **live — POST /setup with `create_channel` now returns 200 and creates a real channel (resolved to `slack_create_channel`, id C0BF3GQJZ29)** |
| S8-3 | Session bootstrap fetches the tenant's existing Slack channels (`conversations.list`) into `capabilities.slackChannels`; converger prompt lists them and requires a `slack_create_channel` setup action before delivering to a channel not in the list. (Also fixed the fetch: `getSlackToken` returns `{botToken}`, nullable → `grant?.botToken ?? SLACK_BOT_TOKEN`.) | **live — building to a non-existent channel now makes the converger flag it and propose `slack_create_channel` {name, is_private} proactively** |

Net: the one-off setup-action capability now works end-to-end — converger detects a missing
channel/folder, proposes creating it, and "Create it now" actually creates it. Test channels created
during verification: `#atlas-standup`, `#atlas-fix-verify` (Slack artifacts; archive when convenient).

### Session 8c — Slack reality check (looked at the actual Slack workspace, 2026-07-04)

The user checked their real Slack and nothing Atlas did was visible. Investigated directly in the
Agntic workspace (T0B3RTT3Z5X, the same workspace Atlas is OAuth-connected to).

| ID | Sev | Finding |
|----|-----|---------|
| S8-6 | **HIGH — value-breaking** | **Atlas-created Slack channels are invisible to the operator.** Navigating to the created channel by id confirmed it IS real ("@Atlas created this channel today… Atlas APP joined #atlas-fix-verify"), but Slack shows a **"Join Channel"** button — the human user (Charles) was never added. `slack_create_channel` (conversations.create) only joins the BOT; it does not invite the connecting user, so the channel never appears in their sidebar. Combined with S8-4/S8-3 this means: Atlas says "Done! #atlas-standup is live," the channel really is created, and the operator sees nothing. Fix: after creating a channel, invite the workspace owner / connecting user (conversations.invite — the `slack_invite` capability already exists) so it shows up for them. |
| S8-7 | note | **No Atlas workflow ever actually posted to Slack.** Every Slack *post* attempted in these sessions failed pre-creation (channel_not_found) or the workflow was never run, so there are zero Atlas messages in the workspace. The only successful Slack operations were channel *creations* (invisible per S8-6). Net operator-visible Slack output so far: nothing. |

**Verification-methodology correction:** my earlier "verified live" for the Slack setup action was true at
the API/data layer (conversations.create returned a real channel id, conversations.list showed it) but
NOT at the operator-visible layer. The channel exists; the user can't see it. Verify user-visible
outcomes, not just successful API responses — the whole product thesis is about what the non-technical
operator actually experiences.
