# P5 readiness brief — Console UI + SOP export

Prepared 2026-06-18, immediately after P4 merged to `main`. **Re-grounded against
current code** (file:line below are live as of this date — re-verify before relying
on them; they drift). P5 is **not started** here — this is the runway so the fresh
P5 session begins from verified state.

## Sequencing
- P4 is merged (`git log --grep "^Gate:"` shows P0→P4). **Branch P5 from `main`**
  (greenfield UI → may worktree-isolate per the build rules). Do not start until a
  fresh session.
- **Design-first** (same as P4): generate console mockups → user approval → build.
  One design asset already exists (see below).

## Done-when (build plan §Phase 5 + `scripts/gates/p5.sh`)
She **sees her automations** (inventory), **watches a run execute step-by-step**
(live run monitoring) and **reads the logs**; the **SOP view** shows steps with
dependencies; and she can **export a workflow's SOP as PDF + Markdown**.

## What already EXISTS (verified) — P5 is mostly endpoints + UI, not storage
- **Run storage is real and populated by the scheduler.** `workflow_runs` table
  (id, workflow_id, user_id, tenant_id, started_at, completed_at, status, output,
  error, is_test, steps). The scheduler records runs: `startRun()` /
  `completeRun()` (`src/workflows/workflow-scheduler.js:167,172,202,242`).
- **Store query methods already exist** (`src/workflows/workflow-store.js`) — most
  of P5's data layer:
  - `list({status,kind,userId,tenantId})` :423 — **inventory**
  - `getRuns(workflowId,limit,{userId})` :619 — **run ledger**
  - `getRun(runId,{userId})` :642 — **per-run detail / drawer**
  - `getLastRun` :631, `getRecentRuns` :708, `getCostByWorkflow` :600,
    `getVersions/getVersion` :740/750
- **Gate stub exists, fail-closed** — `scripts/gates/p5.sh` (currently `exit 1`
  with the Done-when in its header; fill the real check as you build).
- **Design asset** — Live Dashboard mockup saved at
  `docs/design/mockups/Atlas - Live Dashboard.dc.html` (+ drawer/output
  screenshots). Maps every section to endpoints (see "MISSING").
- **Reusable UI** — `public/index.html` already has the dc-runtime component, the
  sidebar, and a **live-mode pipeline render**; the console can reuse these patterns
  (and the `support.js` runtime).

## What's MISSING (the actual P5 work)
1. **API endpoints — none mounted except `POST /workflows/run`** (`src/api/server.js:714`).
   Each maps onto an existing store method; the work is mounting + tenant-scoping:
   - `GET /workflows` → `store.list()` (inventory; **fixes deferred follow-up #1** —
     the single-slot sidebar)
   - `GET /workflows/:id` → `store.get()`
   - `GET /workflows/:id/runs` → `store.getRuns()` (ledger + filters)
   - `GET /workflows/:id/runs/:runId` → `store.getRun()` (drawer trace)
   - `GET /workflows/:id/metrics` → rollup derived from `getRuns()` / `getCostByWorkflow()`
   - `POST /workflows/:id/pause` → `store.update()` status
2. **UI surfaces (net-new, greenfield):** console **inventory** (sidebar list wired
   to `GET /workflows`), the **live dashboard** (mockup), the **SOP view** (steps +
   dependencies from the spec), and **SOP export** (PDF + Markdown).
3. **SOP export is fully net-new** — no SOP/PDF/Markdown scaffolding exists anywhere
   (`grep -ri sop src docs` → nothing). Derive from the live spec so it stays in sync.
4. **Builder "Run test" runs are NOT recorded** — `/workflows/run` does not call
   `startRun/completeRun` (only the scheduler does). So the ledger shows *scheduled*
   runs only. Decide in P5 whether to persist test runs with `is_test=1` (the column
   + `getRecentRuns({excludeTests})` already anticipate this). NB: "Daily Alpha
   Mindset Drop" is a 4am cron — its ledger is empty until it fires.

## Constraints / gotchas to honor
- **Multi-tenant fail-closed (load-bearing).** The store read methods scope only
  when `userId`/`tenantId` are passed — **undefined returns UNSCOPED rows**
  (`list` :423, `getRuns` :619). Worse, `getRuns/getRun` take only `userId`, **no
  `tenantId`**. Every new P5 endpoint MUST pass `req.tenant.id` (+ user), and the
  run-query methods likely need a `tenantId` param added so cross-tenant run access
  is structurally impossible. Prove with an adversarial cross-tenant test (per the
  constitution's tenancy mandate).
- **No mock data.** The Live Dashboard must render real runs or honest empty states —
  the fixture-data anti-pattern removed from the P4 Draft page (2026-06-18).
- **Don't refactor salvage** (the engine/store) without recording the decision in
  ENGINEERING-LOG.md; adding a `tenantId` param to `getRuns` is a tenancy-scoping edit in the
  spirit of the approved multi-tenancy salvage edits.

## Suggested real check to fill `scripts/gates/p5.sh` (during P5, not now)
- `GET /workflows` lists the tenant's workflow(s); cross-tenant request returns none.
- A run renders **per-step** from `GET …/runs/:runId`.
- SOP export produces a **PDF and a Markdown** file for a workflow, derived from its spec.

## First moves for the P5 session
1. Branch `feat/p5-console` from `main` (or worktree).
2. Mock the console (inventory + live dashboard from the saved mockup + SOP view) →
   get approval (design-first).
3. Mount the read endpoints over the existing store methods **with tenant scoping**;
   add `tenantId` to the run-query methods; cross-tenant test.
4. Build the console UI; wire the sidebar to `GET /workflows` (closes follow-up #1).
5. Build SOP view + PDF/Markdown export.
6. Fill `scripts/gates/p5.sh` with the real check; close via fresh verifier.
