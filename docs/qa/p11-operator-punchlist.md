# P11 Product Hardening — Operator App Punch-List

**Surface:** `public/index.html` (operator app: builder · console · connections · value/ROI)
**Method:** Phase 1 code-level logic audit (3 parallel read-only auditors) → Phase 2 live drive-through to confirm/repro.
**Context:** audited at `main` HEAD `b68b5af`; live server booted fresh (`NODE_ENV=development`, uptime-verified current — the prior on-box server was 7 days stale and predated the last `server.js` edit, so it was killed before any live testing).
**Started:** 2026-07-03.

This is the durable QA ledger for the P11 product-hardening effort — it survives session
boundaries. Update the **Status** column as items are confirmed / fixed / dismissed. Do not
delete rows; mark them `FIXED (commit)` or `WONTFIX (reason)`.

Status legend: `CODE-CONFIRMED` (traced to file:line, not yet live-repro'd) · `NEEDS-REPRO`
(suspected, needs live confirmation) · `FIXED` · `WONTFIX`.

---

## Ranked findings

| ID | Sev | Surface | Summary | Evidence | Status |
|----|-----|---------|---------|----------|--------|
| Q01 | MAJOR | console | "Live run monitoring" never updates on its own — console has **no polling**; a running/scheduled run's row & metrics stay frozen until manual re-nav | `public/index.html:2885` (`_loadConsoleData` only called from openConsole/pause/runNow); no `setInterval` for console; commit `2677fb4` polling patched *admin*, not console | **FIXED** — 5s self-terminating poll (`_startConsolePoll`/`_stopConsolePoll`/`_pollConsoleData`), non-disruptive (no `consoleLoading`), stale-guarded; syntax-checked + served live. **Browser-CONFIRMED 2026-07-03**: with the console open (no nav), a synthetic run flipped `running→success` in the DB surfaced on its own within one 5s poll — row Running→Success, success-rate 92%→100%, "last just now"→"1m ago"; poll triplet (`/workflows/:id` + `/runs` + `/metrics`) observed recurring in the network log. |
| Q02 | MAJOR | value | Two contradictory customer-facing "time saved" numbers: Home = `totalRuns × 3min` incl. **test + failed** runs, capped at 20/wf; Profile/console ROI filters `!is_test && success` w/ baseline math | Home: `src/api/builder.js:1035`,`:966`,`:977`; ROI: `src/api/console.js:287`,`:172` | **FIXED** — unified `src/workflows/time-saved.js` (measured-or-estimate, real successes only); Home===ROI===sum(Profile). Verified 24min===24min (old buggy=36min). Server rebooted clean. |
| Q03 | MAJOR | console | SOP export / DAG / SOP tab are blind to `connector-action` nodes (the dominant real step type) → Type renders the raw slug `connector-action`, no descriptive sentence, and **no config surfaced** (connector/capability/base/target) while `summarize`/`deliver` steps get rich descriptions | `src/workflows/sop-generator.js:9-18,54-79,81-92`; `public/index.html:4509`,`:4469-4470` | **FIXED** — generic connector/capability derivation by action-prefix (sop-generator.js + mirrored in index.html `_connectorAction`); step now reads "Airtable — Create Record" + description + Action/base/table/fields config. Verified via real generator; DAG + SOP tab updated. |
| Q04 | MAJOR | builder | In-flight chat SSE stream is never cancelled on **+ New workflow / reset / draft switch** → abandoned reply + "Build it" CTA leak into an unrelated new conversation | no `AbortController` anywhere; `public/index.html:3219-3316` (`sendChat`), `2104-2119` (`reset`), `2129-2142` (`newWorkflow`) | **FIXED** — `_abortChat()` (generation token + AbortController); `sendChat` tags each turn and guards fetch/reader/typewriter/catch by generation; called from `reset()` and `openConsole()`. Syntax-checked + served. **Browser-CONFIRMED 2026-07-03**: sent a chat, clicked "+ New workflow" mid-stream (chat POST in-flight per network log); the new convo rendered clean — no leaked reply / CTA / streaming bubble, and stayed clean after a 5s settle. |
| Q05 | MAJOR | builder | Truncated SSE (tunnel blip / restart before terminal event) hangs UI in `thinking` **forever** — spinner spins, input disabled, no error; user must reload | `public/index.html:3284-3315` (loop breaks on `done` with no post-loop cleanup; `thinking` only cleared on first chunk or terminal event) | **FIXED** — post-loop cleanup: if stream ended with no terminal event (`!twDone`), clears `thinking`, strips the dangling streaming flag, and surfaces a retry error if nothing streamed. No-ops on normal/abort paths. Syntax-checked + served. **Browser-CONFIRMED 2026-07-03**: patched `fetch` so `/api/builder/chat` returned a 200 body stream that closed immediately (dropped SSE, nothing streamed); on send, the spinner did **not** hang — thinking cleared and "⚠ The connection dropped before Atlas replied. Please try again." rendered, input re-enabled. |
| Q06 | MAJOR | builder | Approve/publish has no in-flight guard — **double-click "Approve & go live" creates duplicate workflows** (`name` + `name-2`) | `public/index.html:3678-3682` (`approveDraft` guards on `phase`, which only flips in the async `.then` at `:3704`); button `:642` has no disabled binding | **FIXED (code-verified; live double-click blocked)** — synchronous `_saving` in-flight guard on `_saveWorkflow` (covers both the approve-draft and converger-done callers), cleared in `.finally`. Read in full 2026-07-03: `_saving` is set before the fetch and short-circuits re-entry (`if (this._saving) return`), so a double-click can't double-persist; drafts also now carry a `workflowId`, making approve a PUT (idempotent) not a POST-create — a second layer against `name-2`. **Live Approve double-click could not be driven**: the mandatory test gate before the Approve pane requires `testState:"passed"`, and every test run failed on a real Slack `channel_not_found` (see Q30) which the converger would not repoint — so phase never reached `"draft"`. |
| Q07 | MAJOR | console | `downloadSop` never checks `r.ok` → a failed export (404/500 JSON body) silently downloads a **corrupt file** named `.pdf`/`.md`; `.catch(()=>{})` swallows it | `public/index.html:3122-3134`; server errors `src/api/console.js:331`,`:347` | **FIXED** — throws on `!r.ok` before `blob()`, surfaces an alert instead of downloading garbage. Confirmed `/sop` returns non-2xx (401/404) so the guard fires. Syntax-checked + served. |
| Q08 | MAJOR | value | P9 aggregate ROI report (`GET /api/console/roi`) has **no UI consumer** — the "all-up ROI summary" customer deliverable is orphaned backend code | `src/api/console.js:278`; `grep "console/roi" public/` = 0 hits | **DEFERRED** — not a bug patch but a missing UI surface; needs a design-first decision (dedicated report vs lightweight Home summary). Endpoint now returns unified numbers (post-Q02). Awaiting user direction. |
| Q09 | MAJOR | value | Time-saved is `0`/"—" for any tenant that **never set a baseline** — this is the norm, not an edge: **24/25 workflows have no baseline; `time_saved_minutes` is NULL on all 28 runs** — while Home still shows a bold non-zero number | `src/api/console.js:292-298`; `src/workflows/workflow-scheduler.js:300` (`baselineS>0 ? … : null`); Profile default "Not set" `public/index.html:4434` | **FIXED (via Q02)** — no-baseline runs now yield the flat estimate on every surface, so Profile/ROI/Home agree instead of showing 0 vs non-zero. Baseline still upgrades to measured. |
| Q10 | MEDIUM | builder | `ready_to_build:true` with null/blank `build_intent` → **no "Build it" CTA ever renders**, stranding a user who just confirmed | `public/index.html:3255` (requires both flags); `src/api/builder.js:657`; `startBuild` already has `_deriveBuildIntent()` fallback `:3324` | **FIXED** — CTA now gates on `readyToBuild` alone; `buildIntent` may be null and `startBuild()` derives it from the conversation. Syntax-checked + served. **Browser-CONFIRMED 2026-07-03**: drove a chat to ready-to-build; the "Build it →" CTA rendered. Confirmed the live gate (`public/index.html:3498` `if (twDone.readyToBuild)`, `:3509` `buildIntent = twDone.buildIntent || null`, comment "Gate on readyToBuild alone (Q10)") — null intent handled by `startBuild` derivation `:3586`. |
| Q11 | MAJOR? | builder | Rapid double-Enter may double-submit a chat message (guard reads async `state.thinking`) | `public/index.html:3195-3199`,`:4201` | NEEDS-REPRO |
| Q12 | MINOR | console | Run-detail drawer labels every non-success run **"Failed"**, including in-progress/orphaned `running` runs | `public/index.html:4529`,`:4534`; runs carry `status:'running'` `src/workflows/workflow-store.js:640,649,721` | **FIXED** — drawer now maps success→Completed, error→Failed, running→Running (amber), else title-cased status. **Browser-CONFIRMED 2026-07-03**: opened a synthetic `running` run's detail drawer — header rendered **"Running" in amber** (screenshot), not "Failed"/red; the run-list row also showed an amber dot vs green Success dots. |
| Q13 | MINOR | console | Metrics exclude test runs but run-history list includes them → UI shows **"0 Runs" directly above a list of runs** | metrics filter `src/api/console.js:112-116`; list unfiltered `:63-75`; `public/index.html:4502` | **FIXED** — metrics now include test runs (they're real executions), matching the list. Time-saved/ROI still excludes test runs (value ≠ execution). Decided w/ user 2026-07-03. Server restarted. |
| Q14 | MINOR/MAJOR | connections | Connector "Connected" = grant-**row-exists**, not token-valid → a revoked Airtable/Google refresh token still shows a green "Connected" dot; every run 401/403s | `src/connectors/airtable/oauth.js:239-247`, `slack/oauth.js:161-165`; `src/api/server.js:1288-1290`; `public/index.html:2626` | NEEDS-REPRO |
| Q15 | MINOR | builder | Slash-pinned RAG source names with **spaces** truncate at first space → wrong/no source pinned | `src/api/builder.js:492-493` (`/\/([^\s/]+)/g`); frontend inserts full name `public/index.html:2664-2668` | CODE-CONFIRMED |
| Q16 | MINOR | console | SOP download filename hardcoded `workflow-sop.pdf/.md`, ignores server `Content-Disposition` per-workflow name → every export collides | `public/index.html:3131`; server `src/api/console.js:339,344` | **FIXED** — parses `Content-Disposition` for the server's `<slug>-sop.<ext>` name (falls back to default). Confirmed server sets it for both formats. |
| Q17 | MINOR | builder | Mid-stream chat **error leaves a dangling streaming bubble** (blinking cursor + partial text) beside the error bubble | `public/index.html:3295` (error branch doesn't clear `isStreaming` on the partial bubble) | **FIXED** — `_apiError` now strips a trailing `isStreaming` bubble before appending the ⚠ message (single choke point, covers all callers). |
| Q18 | POLISH | builder | Publish/save failures surface via native blocking `alert()`, inconsistent with the in-chat `⚠` error style used everywhere else | `public/index.html:3700,3710` | CODE-CONFIRMED |
| Q19 | POLISH | connections | Empty "Connected" section renders a bare header with no rows / no empty-state on a fresh tenant | `public/index.html:1501-1511`,`:2080` | **FIXED** — "Connected" section hidden via `sc-if hasConnected`; the remaining header reads "Connectors" (not "Inactive") when nothing is connected. Full JS block syntax-checked + served. **Browser-CONFIRMED 2026-07-03**: agntic is fully connected (renders "CONNECTED" + 4 rows correctly); drove the empty state by patching the 4 `/connectors/*/status` fetches to return not-connected — flyout then showed **no "CONNECTED" header** and a single **"CONNECTORS"** header over the 4 available rows. |
| Q20 | POLISH | connections | Filesystem connector absent from the "Connections" flyout (only in Knowledge view) — discoverability gap | `public/index.html:2625` (fetches only slack/google/airtable/web) | CODE-CONFIRMED |
| Q21 | POLISH | console | Metrics "Runs" count vs visible list (`.slice(0,40)`) diverge for >40-run workflows; no pagination / "show more" | `public/index.html:4488`,`:4502` | CODE-CONFIRMED |

---

## Verified NOT defective (do not re-chase)

- **Tenant/scope isolation (console) is solid.** Every run-query passes `userId` + `tenantId`; single-workflow reads use an explicit `wf.tenant_id !== req.tenant.id` 404 guard. The known P5 gap (getRuns/getRun lacking tenantId) is **closed**. (`src/api/console.js:26-34,63-66,89-92,109-112,169-172,286`)
- **Delete-state fix (`4740312`) holds** — `softDeleteWorkflow` patches both `consoleSidebarWfs` and `homeData.workflows` and reloads home. (`public/index.html:2773-2794`)
- **Publish payload correctness** — builder POST/PUT pass `tenantId: req.tenant.id` + `status:'active'`; the old missing-tenantId/status history does not recur. (`src/api/builder.js:1327-1330`)
- **CSS render guard present & sufficient** — `sc-if, sc-for { display:none }` at `public/index.html:58` covers every `background:url('{{…}}')` in the flyout (all inside `<sc-for>`/`<sc-if>`).
- **Web-connector logic coherent** — connected iff `ANTHROPIC_API_KEY && !tenant-disabled`; enable/disable path works; no dead button. (`src/api/server.js:1556-1559`)
- **Money/time formatters don't NaN/÷0** — `success_rate` guards `totalRuns>0`; `_fmtSeconds` guards `s<=0 → "—"`.
- **CTA reload survival & draft recovery** — CTA stored as serializable fields, `onClick` reattached at render; dual-keyed localStorage recovers per-draft transcripts.

---

## Phase 2 — live confirmation log (2026-07-03)

Confirmed against the live DB (`memory/workflows/workflows.sqlite`, 25 workflows / 2 tenants) and the real SOP generator, on the freshly-restarted server:

- **Q02 / Q13 (data):** `workflow_runs` = 28 total → **13 real successes**, 14 test runs, 1 error. Home's `totalRuns × 3` counts all 28 (test + error included) → the customer-facing "time saved" is inflated ~2× vs the ROI figure that filters `!is_test && success`.
- **Q09 (data):** **24 of 25 workflows have `baseline_duration_s = 0`**; `time_saved_minutes` is **NULL on all 28 runs**. Of the 5 workflows with real successful runs, only 1 (`Gmail Interaction Logger`, 72s) has a baseline. → Profile/ROI "time saved" is ~0 platform-wide, contradicting Home. Baseline-unset is the 96% case, not an edge.
- **Q03 (live SOP):** ran `generateSopMarkdown` on `Gmail → Airtable Interaction Log & Slack Summary` (nodes: summarize, **connector-action**, deliver). The connector-action step rendered `**Type:** connector-action` (raw slug), used the bare node label as its only description, and surfaced **no config** — while the sibling `deliver` step got "Sends the processed output to Slack #social · Channel · Target". Uninformative for the customer SOP.
- **Q05 / Q12 (data):** 0 runs currently in `status='running'` — defect is code-real but not live-observable right now.

## Behavioral findings — left-sidebar workflow store (from real usage, 2026-07-03)

User report: the sidebar "felt glitchy, like workflows weren't saved after leaving the page." Investigated against live code + DB + event log.

| ID | Sev | Summary | Evidence | Status |
|----|-----|---------|----------|--------|
| Q22 | MAJOR | **Eager phantom drafts** — `newWorkflow()` POSTed `/api/builder/draft` the instant "+ New workflow" was clicked, persisting an empty "New workflow" draft before the user typed anything; abandoning it (or clicking "+" repeatedly) litters the sidebar permanently | `public/index.html` `newWorkflow` (eager POST); live DB has 1 empty `nodes:"[]"` draft | **FIXED** — draft now created lazily via `_ensureDraft()` on the first message (`_submitNewState`); "+ New" + back-out leaves no phantom. The current build is still reload-recoverable via the primary `_buildKey` slot (not workflowId-keyed). **Browser-CONFIRMED 2026-07-03**: clicked "+ New workflow" → DB stayed at exactly 2 workflows, no empty-node/`Untitled` row, and the only `/api/builder/draft` POST in the event log was from June 28 (not this click); backing out removed the ephemeral "Untitled workflow" from the sidebar with nothing persisted. |
| Q23 | MAJOR | **Draft content is localStorage-only until publish** — a built-but-unpublished workflow's conversation/spec never persists server-side; it survives reload in the same browser (primary `_buildKey` slot) but is **gone on another device / after clearing storage**, which reads as "my workflow wasn't saved" | `public/index.html` `_saveBuild`/`_buildKeyWf` (localStorage only); server draft row has empty `nodes` until the publish PUT | **FIXED (option A)** — `PUT /workflows/:id/draft` autosaves the spec server-side (no validate/activate, no version churn via `snapshot:false`); `_persistDraftServer()` debounced from `_saveBuild`; `openConsole` hydrates any draft into the builder (localStorage → server spec → fresh). Store test: nodes persist, version stays 1, 0 snapshot churn. |
| Q24 | MINOR | Possible **delete double-fire** — event log shows DELETE on one workflow id logging `404` then `200` (same id), hinting at two delete requests racing | `memory/logs/atlas-events.log`; `softDeleteWorkflow` optimistic path | NEEDS-REPRO — low priority; the optimistic UI already removes the row, so user impact is cosmetic. |

**Ruled out** (investigated, not the bug): localStorage key instability — `userEmail`/`tenantId` are set atomically with `authToken` in `_applyAuth` and `_saveBuild` bails until then, so save/restore keys always match; published workflows reliably reload on boot (`_loadWorkflows`). The "not saved" symptom is Q22 (phantom clutter) + Q23 (local-only drafts), not lost published data.

## Scheduler — CRITICAL (from user report: live workflow silent ~7 days, 2026-07-03)

| ID | Sev | Summary | Evidence | Status |
|----|-----|---------|----------|--------|
| Q25 | **BLOCKER** | `_isFlowDue` read cron from `t.config?.cron`, but stored triggers put it directly on the trigger (`{type:'schedule',cron:'0 5 * * *'}`) → schedule invisible, workflow **never due**, no output for days | `src/workflows/workflow-store.js` `_isFlowDue` | **FIXED** — read `t.cron ?? t.config?.cron` (+ time). Verified getDue() 0→recognizes schedules. |
| Q26 | **BLOCKER** | `getDue()` had no `deleted_at IS NULL` filter → 8 soft-deleted workflows still scheduled; fixing Q25 alone would fire ~5 deleted workflows into Slack/email | `workflow-store.js` `getDue` | **FIXED** — added `deleted_at IS NULL`. Verified getDue()=1 (only the live workflow). |
| Q28 | MAJOR | Missed runs (scheduler down at 5am) would silently auto-fire hours late; owner wants notify + choose (run/edit/defer) | owner decision 2026-07-03 | **FIXED (detection)** — grace window (`SCHEDULE_GRACE_HOURS`, default 2h); `_flowScheduleState`→due/overdue/null; `getOverdue()`. Verified overdue not auto-fired on restart. **UI notification pending.** |
| Q27 | MINOR | `_isFlowDue` uses server-local time, ignores trigger `timezone` — fires at server-local hour | `workflow-store.js` | OPEN — harmless now (server TZ = Central = trigger TZ); real when multi-TZ / non-Central host. |
| — | — | Scheduler *was* started (server.js:713, default on) but the 7-day server was stale (booted pre-wiring). Restarted; now logs `[scheduler] started — tick 60s`. | — | RESOLVED (restart + observability). |

**Root-cause of the 7-day silence:** stale server (never ticked) **and** Q25 (never due even if ticking). Both fixed; scheduler now live and will fire on-time. 1 workflow ("AI Morning Briefing") is currently **overdue** — awaiting the owner-notification UI so you can run/defer it.

## Remediation status (2026-07-03)

**Fixed & committed (11):** Q01, Q02, Q03, Q04, Q05, Q06, Q07, Q09, Q12, Q16, Q17.
Each verified to the ceiling possible headlessly — `node --check` on the x-dc
script / changed modules, served-by-live-server confirmation, and data-layer /
real-generator proof where applicable. Server restarted after every backend
change; the running process is current (frontend is static-served from disk).

**Open:**
- **Q08 (MAJOR) — DEFERRED:** missing ROI-report UI; needs a design-first
  decision (dedicated report view vs lightweight Home summary). Not a bug patch.
- **Q11 (MAJOR?, NEEDS-REPRO):** double-Enter double-submit — needs a real
  browser to confirm the timing window; a synchronous in-flight flag on
  `submitInput`/`sendChat` would close it if confirmed.
- **Q14 (MINOR/MAJOR, NEEDS-REPRO):** connector "Connected" = grant-row-exists,
  not token-valid — needs a revoked-token repro; fix would add a validity probe
  or lazy refresh check to the status endpoints.
- **Minors/polish not yet done:** Q10 (CTA on `ready_to_build` alone — safe,
  small), Q13 ("0 Runs" above a test-run list — small product call), Q15 (slash
  filename spaces — backend regex), Q18 (alert vs in-chat error), Q19 (empty
  Connected section), Q20 (Filesystem not in flyout — product call), Q21 (>40-run
  pagination — product call).

**Verification gap:** no headless browser driver this session, so the frontend
fixes are code-verified (syntax + served + logic) but not yet *behaviorally*
driven in a browser. Recommend a click-through of localhost:3000 (or wiring a
Chrome driver) to confirm Q01/Q04/Q05/Q06 UX. — **CLOSED 2026-07-03**, see below.

**Not yet audited:** the admin app (`src/admin/index.html`).

## Phase 2b — browser drive-through (2026-07-03, Chrome DevTools MCP)

Server **restarted first** (two backend commits — Q08 21:02, Q23 21:18 — landed
*after* the running server booted at 20:57, so it was stale for those; killed +
rebooted clean, `[scheduler] started`, `llm anthropic`). Logged in as
charles@agntic.co (tenant `agntic`). Eight frontend fixes driven in a real browser:

| ID | Result | How |
|----|--------|-----|
| Q01 | ✅ CONFIRMED | Console open, no nav; flipped a synthetic run `running→success` in the DB → row + metrics updated themselves within one 5s poll. Poll triplet seen recurring in the network log. |
| Q04 | ✅ CONFIRMED | Chat sent, "+ New workflow" clicked mid-stream → new convo clean, no leak, stable after 5s. |
| Q05 | ✅ CONFIRMED | Patched `/api/builder/chat` to drop the SSE body immediately → spinner cleared + retry error shown, input re-enabled (no hang). |
| Q06 | ⚠️ CODE-VERIFIED, live double-click blocked | `_saving` guard read in full (correct; covers both callers). Couldn't reach the Approve pane: its test gate needs `testState:"passed"`, but every test run failed `channel_not_found` (Q30). |
| Q10 | ✅ CONFIRMED | Drove chat to ready-to-build → "Build it →" CTA rendered; live gate is `readyToBuild` alone. |
| Q12 | ✅ CONFIRMED | Synthetic `running` run drawer header = **"Running" (amber)**, not Failed (screenshot). |
| Q19 | ✅ CONFIRMED | Patched connector-status fetches empty → flyout hid the "CONNECTED" header, single header read **"CONNECTORS"**. |
| Q22 | ✅ CONFIRMED | "+ New" then back-out → DB stayed at 2 workflows, no phantom draft POST. |

All synthetic DB rows (1 `running` run) and 4 test-artifact draft workflows created
during the drive-through were cleaned up (soft-deleted / deleted); the agntic tenant
is back to its 2 real workflows.

**Pre-commit re-verification (same fresh server, no leftover patches):** re-drove all
seven behavioral fixes a second time from a clean state — Q22, Q19 (both connected +
empty paths), Q01, Q12, Q10, Q04, Q05 — all reproduced their fixed behavior again. One
incidental note: the first Q10 re-attempt used a Slack intent and the chat model derailed
into "I can't build scheduled workflows from chat" (never set `ready_to_build`, so no CTA)
— the documented tool-mode flakiness, not a Q10 regression; a Slack-free (email) intent
reached ready-to-build and rendered the CTA on the first turn. Re-verify artifacts (3 empty
drafts) cleaned up; tenant back to 2 real workflows.

### New findings — converger behavior (discovered during the drive-through)

Surfaced live while trying to build/publish real workflows to reach the Q06 Approve
pane. First-hand, same-session observations; marked NEEDS-REPRO for a clean minimal
repro before any fix (the converger is non-deterministic — re-ground before acting).

| ID | Sev | Summary | Evidence | Status |
|----|-----|---------|----------|--------|
| Q29 | MAJOR | **Converger can't finalize a workflow with no processing step (trigger → deliver only)** — after confirming a schedule trigger + a static Slack deliver, it looped "I need a bit more detail to build the next step" to every completion signal and never emitted the `proposed` spec; the test panel stayed "Incomplete"/locked, so the workflow could not be tested or published *at all*. A workflow *with* a processing step (summarize) finalized fine. | **Root cause (deterministic, no LLM):** `src/converger/gap-scorer.js` requires a processing node for `complete` (`needsProcessing = hasTrigger && !hasProcessing`), so a trigger+delivery draft is `complete:false` forever; `elicitation-graph.js` `analyze` only ratifies on `gap.complete`, and `propose` falls to the fallback interrupt (`:172`) when the LLM has no next component → unbreakable loop. Repro: `scripts/checks/p11-converger-q29-repro.mjs` (exit 0 = reproduced). Also violates the workflow-agnostic constitution. | **REPRODUCED (deterministic) — NEEDS-FIX** (make processing optional when trigger+delivery+edges+name present). |
| Q30 | MAJOR | **Post-build change won't repoint a deliver node's target** — asked to change the Slack channel `#general→#social` it updated only the display *name* (deliver config stayed, test still failed `channel_not_found`); asked to "deliver by email instead of Slack" it added an unrelated "Format as HTML Email" LLM step but left the Slack deliver node (`deliver_to_general`) unchanged. Net: a real `channel_not_found` break can't be fixed via chat, blocking test/publish. | Path is `POST /api/builder/edit-change` (`src/api/builder.js:1105-1157`) — **LLM-driven spec rewrite** (`modelTier:'balanced'`), so behavior is prompt-adherence, not deterministic. Its own rule says "if the requested channel/method is UNAVAILABLE, keep the node UNCHANGED and explain" — so leaving the deliver on an unavailable channel is partly by design, but (a) the workflow *name* still got repointed to "#social" → internally inconsistent spec, and (b) the email switch (Google connected, so available) was not applied. Live: "Daily Unread Email Digest"; 2 attempts, deliver node unchanged, test broke `deliver_to_general: channel_not_found` on all 3 runs. | NEEDS-REPRO (LLM-behavioral) |

*Note:* the `channel_not_found` itself is an environment/connector fact (the tenant's
Slack bot isn't in `#general` or `#social`), not a bug. Q29 is a deterministic code
defect with a committed repro; Q30 is LLM prompt-adherence in `edit-change` and needs a
seeded/repeated repro (and possibly a determinism guard, e.g. keep name+config in sync)
before any fix.
