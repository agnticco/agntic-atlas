# Atlas — Tier Entitlement Gating (build spec)

**Status:** approved design, **not yet built**. This document is the implementation brief
for the agent that will add tiered plan gating to the codebase.

**Provenance / re-grounding rule:** the file:line references below come from a live read-only
audit (2026-07-06). They are **non-authoritative provenance** — the invariant + the named
function/behavior is the contract. Re-ground each reference against current code before editing;
if a coordinate has drifted, trust the code and the described invariant, not the line number.

---

## 1. Context — there is no entitlement layer today

A codebase-wide audit found **zero** plan/tier/quota/entitlement enforcement. Greps for
`plan|tier|quota|entitlement|subscription|maxWorkflows|runLimit|fairUse` return only:
LLM model-routing "tiers" (`src/llm/model-pool.js`), agent-graph "plan" nodes
(`src/graph/*`), and third-party-API quota *error strings* (`src/workflows/error-translator.js`).
Every feature is currently open to every authenticated tenant.

**Implication:** this is greenfield plumbing, not flag-flipping. Build a single central
entitlements module and enforce from it — **never** hardcode per-tier `if (plan === 'team')`
logic at call sites (mirrors the repo rule: add a generic, data-driven branch, not a
special-case).

---

## 2. Plan model

Add a `plan` column to the tenant record (enum, `NOT NULL`, default `'starter'`):

- `starter` · `team` · `enterprise` · `founding`

Set at provisioning/onboarding. **Founding pilots (the current cohort) → `'founding'`**
(grandfathered full access — see matrix). Resolve the plan into `req.entitlements` in the same
middleware that resolves `req.tenant` so every route has it.

`founding` is a real, monitored plan (small hand-picked cohort): **all features ON**, Team-level
volume, but flagged `monitored: true` so the run-budget check *notifies* rather than hard-blocks.

---

## 3. Entitlements matrix (authoritative)

| Key | Starter | Team | Enterprise | Founding | Enforcement (see §5) |
|---|---|---|---|---|---|
| `seats` (users/tenant) | **1** | ∞ | ∞ | ∞ | new invite endpoint |
| `activeWorkflows` (published, **not drafts**) | **5** | **25** | ∞ | 25 | `workflow-service.create` |
| `monthlyRuns` (fair-use, excl. test runs) | **600** | **1,500** | ∞ | 600 *(soft)* | run entry paths + counter |
| `subDailySchedule` (every N min/hrs) | ✗ | ✓ | ✓ | ✓ | create/validate |
| `eventTriggers` (connector events) | ✗ | ✓ | ✓ | ✓ | create/validate |
| `autoRetry` (`error_handling.retry`) | ✗ | ✓ | ✓ | ✓ | create + scheduler |
| `failureNotify` (`error_handling.notify`) | ✗ | ✓ | ✓ | ✓ | create + scheduler |
| `roiReportExport` (aggregate ROI + SOP/PDF export) | ✗ | ✓ | ✓ | ✓ | console routes |
| `historyRetentionDays` (console view window) | **30** | ∞ | ∞ | ∞ | console run queries |
| **All connectors** (Slack/Google/Airtable/Web/Knowledge/Inbox) | ✓ | ✓ | ✓ | ✓ | **not gated** |
| `aiHomeAssists` (LLM greeting/tip/alert summary) | ✓ | ✓ | ✓ | ✓ | **not gated** (on for all) |
| Consulting (2 hrs/mo) | — | — | ✓ (ops, not code) | — | n/a |

Values are the single source of truth. Everything not listed is available on all plans.

---

## 4. Central entitlements module

Create `src/entitlements/index.js`:

```js
export const PLANS = {
  starter:    { seats: 1,        activeWorkflows: 5,        monthlyRuns: 600,
                subDailySchedule: false, eventTriggers: false, autoRetry: false,
                failureNotify: false, roiReportExport: false, historyRetentionDays: 30,
                aiHomeAssists: true },   // not gated — on for all plans (owner decision)
  team:       { seats: Infinity, activeWorkflows: 25,       monthlyRuns: 1500,
                subDailySchedule: true,  eventTriggers: true,  autoRetry: true,
                failureNotify: true,  roiReportExport: true,  historyRetentionDays: Infinity,
                aiHomeAssists: true },
  enterprise: { seats: Infinity, activeWorkflows: Infinity, monthlyRuns: Infinity,
                subDailySchedule: true,  eventTriggers: true,  autoRetry: true,
                failureNotify: true,  roiReportExport: true,  historyRetentionDays: Infinity,
                aiHomeAssists: true },
  founding:   { seats: Infinity, activeWorkflows: 25,       monthlyRuns: 600, monitored: true,
                subDailySchedule: true,  eventTriggers: true,  autoRetry: true,
                failureNotify: true,  roiReportExport: true,  historyRetentionDays: Infinity,
                aiHomeAssists: true },
};

export function entitlement(plan, key) {
  return (PLANS[plan] ?? PLANS.starter)[key];
}

export class PlanLimitError extends Error {
  constructor(feature, plan, upgradeTo = 'team') {
    super(`plan_limit:${feature}`);
    this.status = 402; this.code = 'PLAN_LIMIT';
    this.feature = feature; this.plan = plan; this.upgradeTo = upgradeTo;
  }
}

export function assertFeature(plan, key) {
  if (!entitlement(plan, key)) throw new PlanLimitError(key, plan);
}
```

**Error contract (uniform):** every gate returns **HTTP 402** with
`{ error: <friendly message>, code: 'PLAN_LIMIT', feature: <key>, plan: <current>, upgradeTo: 'team' }`.
The UI keys off `code === 'PLAN_LIMIT'` to render an upgrade prompt naming `feature`.

---

## 5. Enforcement points (per gate)

For each: **where** (audited coordinate), **the check**, and **behavior**.

### 5.1 `seats`
- **Where:** *new* route `POST /api/users` (tenant-admin adds a teammate), gated by
  `requireActiveTenant` + admin role. Today only the **platform-admin** route
  `POST /tenants/:id/users` exists (`src/api/server.js:1118`); there is **no** tenant-self-serve
  add-user path — build it, calling `userStore.create({ tenantId: req.tenant.id, ... })`.
- **Check:** `userStore.countForTenant(req.tenant.id)` (`src/auth/user-store.js:178`) `< entitlement(plan,'seats')`.
- **Behavior:** at/over cap → 402 `PLAN_LIMIT` (`feature:'seats'`). Starter is single-user; the
  invite UI should be hidden for Starter and hard-blocked here as defense.

### 5.2 `activeWorkflows`  *(published only — drafts unlimited)*
- **Where:** `workflowService.create()` (`src/workflows/workflow-service.js:83-114`), the
  **publish** path only. Draft creation/save must **not** be gated (users must always be able to
  build and resume unpublished work).
- **Check:** add `workflowStore.countActiveForTenant(tenantId)` (derive from existing
  `list()` filtered to `status IN ('active','draft'→exclude)`; count only published/active),
  compare `< entitlement(plan,'activeWorkflows')`.
- **Behavior:** at/over cap → 402 (`feature:'activeWorkflows'`). Existing workflows keep running;
  only *new* publishes are blocked.

### 5.3 `monthlyRuns` (fair-use, metered)  *— the margin gate*
- **Where (counter increment):** `completeRun()` (`src/workflows/workflow-store.js:676`) and the
  scheduler's completion path (`src/workflows/workflow-scheduler.js:~300`). Increment a
  per-tenant, per-calendar-month counter (`tenant_run_counter(tenant_id, yyyymm, count)`).
  **Exclude test runs** (same exclusion ROI already applies).
- **Where (pre-run check):** all **four** run entry paths —
  1. REST `POST /workflows/run` (`src/api/server.js`),
  2. scheduler tick `_runFlowOnce` (`workflow-scheduler.js`),
  3. Slack `dispatchSlackEvent` (`src/api/server.js:374`),
  4. Airtable `dispatchAirtableEvent` (`src/api/server.js`).
  Add a shared `checkRunBudget(tenantId, plan)` helper.
- **Behavior = SOFT (fair-use, not a hard wall):**
  - `count < cap` → run normally.
  - `cap ≤ count < 2×cap` → **run, but flag the tenant + notify** ("approaching/over your monthly
    runs"). This matches the "we'll reach out to heavy outliers" marketing.
  - `count ≥ 2×cap` → **hard stop** (skip the run, 402 on REST) to cap runaway cost.
  - `founding.monitored` and `enterprise` (∞) → never hard-stop; notify only.
- Reset: counter is keyed by `yyyymm`; a new month is a fresh bucket (no cron needed).

### 5.4 `subDailySchedule`
- **Where:** `workflowService.create()` / `src/workflows/workflow-validator.js` at publish.
- **Check:** inspect `triggers[]` schedule cron. Sub-daily = `*/N * * * *` or `0 */N * * *`
  (the exact patterns parsed at `src/workflows/workflow-store.js:1045-1071`). If sub-daily and
  `!entitlement(plan,'subDailySchedule')` → 402 (`feature:'subDailySchedule'`). Daily/weekly
  always allowed.

### 5.5 `eventTriggers`
- **Where:** same publish-time validation.
- **Check:** if any `triggers[].type` is a connector event
  (`event` / `slack_message` / `slack_mention` / `airtable_record_changed` / `gmail_new_message`)
  and `!entitlement(plan,'eventTriggers')` → 402 (`feature:'eventTriggers'`). Schedule + inbound
  email triggers always allowed.
- **⚠ Caveat:** only **Slack** event triggers fire end-to-end today. Airtable's webhook is
  **not created on publish** (the r23 blocker — creation route exists but is never called) and
  Gmail's trigger is a polling stub. Gate the *feature* now, but don't headline "real-time
  triggers" as a Team differentiator until Airtable's trigger is wired.

### 5.6 `autoRetry` + `failureNotify`
- **Where (primary):** publish-time — if Starter, reject (or strip) `error_handling.retry` and
  `error_handling.notify` from the spec.
- **Where (runtime defense):** the scheduler already reads these — retry wrapper
  (`src/workflows/workflow-scheduler.js:210`) and notifier invocation (`:230`). Add a plan check:
  if `!autoRetry`, force `maxAttempts = 1`; if `!failureNotify`, skip `_errorNotifier`.
- **Behavior:** enforce at **both** layers (UI hides the option; runtime ignores it if smuggled in).

### 5.7 `roiReportExport`
- **Where:** console routes — `GET /api/console/roi` (`src/api/console.js:299`),
  `GET /api/console/roi/export` (`:341`), and `GET /api/console/workflows/:id/sop` **export**
  (`:365`, both `format=pdf` and `format=md` downloads).
- **Check:** `assertFeature(plan, 'roiReportExport')` → 402 if unentitled.
- **Keep on Starter:** the **per-run** `time_saved_minutes` value in run detail
  (`workflow_runs.time_saved_minutes`, `workflow-store.js:103`) stays visible — Starter sees its
  own numbers; Team gets the aggregate report + exportable customer-facing PDF/MD.

### 5.8 `historyRetentionDays`  *(optional / phase-2)*
- **Where:** console run queries `getRuns` (`src/api/console.js:59`) / run detail (`:86`).
- **Check:** for finite `historyRetentionDays`, add a `since = now - Nd` filter to the query for
  that tenant. **Data is retained** (no deletion job exists, and none should be added here) —
  this only limits the console *view* window. Starter = 30 days; others = ∞.

### 5.9 `aiHomeAssists` — **NOT gated** (on for all plans)
- **Owner decision:** the LLM greeting/tip/failure-summary on the home dashboard
  (`src/api/builder.js:1188-1201`) stays enabled for every plan, including Starter — it's a
  first-impression/conversion asset and the marginal LLM cost is accepted. No enforcement here;
  the key is left `true` across all plans in §4 only for shape uniformity. Do **not** add a gate.

---

## 6. User-facing labels & upgrade UX

- **Run cap label:** show as **"Monthly automation runs"** — e.g. *"600 automation runs / mo"*
  or prose *"run your automations up to 600 times a month."* Never surface the raw `monthlyRuns`
  key. **(Confirmed label — 2026-07-06.)**
- **Seats:** "1 user" (Starter) vs "Unlimited users" (Team/Enterprise).
- **Active workflows:** "up to 5 active automations" (Starter) / "25" (Team) / "unlimited"
  (Enterprise). Clarify *drafts don't count*.
- **Upgrade prompt:** any 402 `PLAN_LIMIT` renders an inline "This needs the **Team** plan"
  card naming the blocked `feature` and a request-access CTA (no self-serve checkout exists).

---

## 7. Build order

1. **Foundation** — `plan` column (default `starter`) + `src/entitlements/index.js` +
   `req.entitlements` middleware + the 402 `PLAN_LIMIT` contract. Set founding tenants →
   `'founding'`. *(Ships with #8 onboarding.)*
2. **Cheap config gates (high value, low risk):** `activeWorkflows`, `subDailySchedule`,
   `eventTriggers`, `autoRetry`/`failureNotify`, `roiReportExport`, plus the new seats invite
   endpoint. All are single-point checks against the module.
3. **Metered gate:** `monthlyRuns` — the counter table + `checkRunBudget` in the four run paths.
4. **Optional / later:** `historyRetentionDays`. *(`aiHomeAssists` is not gated — nothing to build.)*

---

## 8. Acceptance / adversarial tests (fail-closed)

A fresh verifier (not the implementer) must prove, per plan:

- **Starter** cannot: add a 2nd user, publish a 6th active workflow, publish a sub-daily or
  event-triggered workflow, save `error_handling.retry/notify`, or hit `/console/roi*` /
  `/sop?format=pdf` (all → 402 `PLAN_LIMIT`).
- **Starter** *can*: create/resume unlimited **drafts**, run manually/scheduled (daily/weekly),
  see its own per-run time-saved.
- **`monthlyRuns`:** at the cap a Starter run is flagged+notified but still executes; at 2× it
  hard-stops; a **new calendar month** resets the budget.
- **Team** has unlimited seats and none of the above blocks; **Founding** behaves as Team
  (all features) with soft run-notify; **Enterprise** is uncapped.
- **Cross-tenant isolation** is unaffected — one tenant's plan/counter never reads another's
  (re-run the existing cross-tenant adversarial suite).

---

## 9. Non-goals / caveats

- **No connector gating** — every connector is available on every plan (owner decision).
- **No self-serve checkout** — 402s point to request-access, not a purchase flow (none exists).
- **Airtable event trigger is not wired** (r23) — see §5.5; don't oversell real-time triggers.
- **Founding is grandfathered** — the current pilot cohort keeps full features regardless of the
  public Starter limits.
