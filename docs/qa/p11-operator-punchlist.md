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
| Q01 | MAJOR | console | "Live run monitoring" never updates on its own — console has **no polling**; a running/scheduled run's row & metrics stay frozen until manual re-nav | `public/index.html:2885` (`_loadConsoleData` only called from openConsole/pause/runNow); no `setInterval` for console; commit `2677fb4` polling patched *admin*, not console | **FIXED** — 5s self-terminating poll (`_startConsolePoll`/`_stopConsolePoll`/`_pollConsoleData`), non-disruptive (no `consoleLoading`), stale-guarded; syntax-checked + served live. Browser behavioral repro pending. |
| Q02 | MAJOR | value | Two contradictory customer-facing "time saved" numbers: Home = `totalRuns × 3min` incl. **test + failed** runs, capped at 20/wf; Profile/console ROI filters `!is_test && success` w/ baseline math | Home: `src/api/builder.js:1035`,`:966`,`:977`; ROI: `src/api/console.js:287`,`:172` | **FIXED** — unified `src/workflows/time-saved.js` (measured-or-estimate, real successes only); Home===ROI===sum(Profile). Verified 24min===24min (old buggy=36min). Server rebooted clean. |
| Q03 | MAJOR | console | SOP export / DAG / SOP tab are blind to `connector-action` nodes (the dominant real step type) → Type renders the raw slug `connector-action`, no descriptive sentence, and **no config surfaced** (connector/capability/base/target) while `summarize`/`deliver` steps get rich descriptions | `src/workflows/sop-generator.js:9-18,54-79,81-92`; `public/index.html:4509`,`:4469-4470` | **FIXED** — generic connector/capability derivation by action-prefix (sop-generator.js + mirrored in index.html `_connectorAction`); step now reads "Airtable — Create Record" + description + Action/base/table/fields config. Verified via real generator; DAG + SOP tab updated. |
| Q04 | MAJOR | builder | In-flight chat SSE stream is never cancelled on **+ New workflow / reset / draft switch** → abandoned reply + "Build it" CTA leak into an unrelated new conversation | no `AbortController` anywhere; `public/index.html:3219-3316` (`sendChat`), `2104-2119` (`reset`), `2129-2142` (`newWorkflow`) | **FIXED** — `_abortChat()` (generation token + AbortController); `sendChat` tags each turn and guards fetch/reader/typewriter/catch by generation; called from `reset()` and `openConsole()`. Syntax-checked + served. Browser repro pending. |
| Q05 | MAJOR | builder | Truncated SSE (tunnel blip / restart before terminal event) hangs UI in `thinking` **forever** — spinner spins, input disabled, no error; user must reload | `public/index.html:3284-3315` (loop breaks on `done` with no post-loop cleanup; `thinking` only cleared on first chunk or terminal event) | CODE-CONFIRMED |
| Q06 | MAJOR | builder | Approve/publish has no in-flight guard — **double-click "Approve & go live" creates duplicate workflows** (`name` + `name-2`) | `public/index.html:3678-3682` (`approveDraft` guards on `phase`, which only flips in the async `.then` at `:3704`); button `:642` has no disabled binding | CODE-CONFIRMED |
| Q07 | MAJOR | console | `downloadSop` never checks `r.ok` → a failed export (404/500 JSON body) silently downloads a **corrupt file** named `.pdf`/`.md`; `.catch(()=>{})` swallows it | `public/index.html:3122-3134`; server errors `src/api/console.js:331`,`:347` | CODE-CONFIRMED |
| Q08 | MAJOR | value | P9 aggregate ROI report (`GET /api/console/roi`) has **no UI consumer** — the "all-up ROI summary" customer deliverable is orphaned backend code | `src/api/console.js:278`; `grep "console/roi" public/` = 0 hits | CODE-CONFIRMED |
| Q09 | MAJOR | value | Time-saved is `0`/"—" for any tenant that **never set a baseline** — this is the norm, not an edge: **24/25 workflows have no baseline; `time_saved_minutes` is NULL on all 28 runs** — while Home still shows a bold non-zero number | `src/api/console.js:292-298`; `src/workflows/workflow-scheduler.js:300` (`baselineS>0 ? … : null`); Profile default "Not set" `public/index.html:4434` | **FIXED (via Q02)** — no-baseline runs now yield the flat estimate on every surface, so Profile/ROI/Home agree instead of showing 0 vs non-zero. Baseline still upgrades to measured. |
| Q10 | MEDIUM | builder | `ready_to_build:true` with null/blank `build_intent` → **no "Build it" CTA ever renders**, stranding a user who just confirmed | `public/index.html:3255` (requires both flags); `src/api/builder.js:657`; `startBuild` already has `_deriveBuildIntent()` fallback `:3324` | CODE-CONFIRMED |
| Q11 | MAJOR? | builder | Rapid double-Enter may double-submit a chat message (guard reads async `state.thinking`) | `public/index.html:3195-3199`,`:4201` | NEEDS-REPRO |
| Q12 | MINOR | console | Run-detail drawer labels every non-success run **"Failed"**, including in-progress/orphaned `running` runs | `public/index.html:4529`,`:4534`; runs carry `status:'running'` `src/workflows/workflow-store.js:640,649,721` | CODE-CONFIRMED (0 running runs in live DB now) |
| Q13 | MINOR | console | Metrics exclude test runs but run-history list includes them → UI shows **"0 Runs" directly above a list of runs** | metrics filter `src/api/console.js:112-116`; list unfiltered `:63-75`; `public/index.html:4502` | CODE-CONFIRMED |
| Q14 | MINOR/MAJOR | connections | Connector "Connected" = grant-**row-exists**, not token-valid → a revoked Airtable/Google refresh token still shows a green "Connected" dot; every run 401/403s | `src/connectors/airtable/oauth.js:239-247`, `slack/oauth.js:161-165`; `src/api/server.js:1288-1290`; `public/index.html:2626` | NEEDS-REPRO |
| Q15 | MINOR | builder | Slash-pinned RAG source names with **spaces** truncate at first space → wrong/no source pinned | `src/api/builder.js:492-493` (`/\/([^\s/]+)/g`); frontend inserts full name `public/index.html:2664-2668` | CODE-CONFIRMED |
| Q16 | MINOR | console | SOP download filename hardcoded `workflow-sop.pdf/.md`, ignores server `Content-Disposition` per-workflow name → every export collides | `public/index.html:3131`; server `src/api/console.js:339,344` | CODE-CONFIRMED |
| Q17 | MINOR | builder | Mid-stream chat **error leaves a dangling streaming bubble** (blinking cursor + partial text) beside the error bubble | `public/index.html:3295` (error branch doesn't clear `isStreaming` on the partial bubble) | CODE-CONFIRMED |
| Q18 | POLISH | builder | Publish/save failures surface via native blocking `alert()`, inconsistent with the in-chat `⚠` error style used everywhere else | `public/index.html:3700,3710` | CODE-CONFIRMED |
| Q19 | POLISH | connections | Empty "Connected" section renders a bare header with no rows / no empty-state on a fresh tenant | `public/index.html:1501-1511`,`:2080` | CODE-CONFIRMED |
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

## Still to do

- **Phase 2 live drive-through** — boot fresh server (done), register a tenant, and repro the NEEDS-REPRO items (Q09, Q11, Q14) plus confirm the top MAJORs (Q01 no-polling, Q02 conflicting ROI, Q03 SOP connector-action) in a real browser; catch any purely-visual/UX defects the code audit can't see.
- **Admin app** (`src/admin/index.html`) — not yet audited this pass.
- **Triage → fix** — group fixes; each fix verified against a restarted process (never a stale one).
