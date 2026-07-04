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
