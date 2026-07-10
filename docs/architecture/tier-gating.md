# Atlas — Tier Entitlement Gating (pilot/alpha pricing)

**Status:** built & wired (2026-07-09). This supersedes the earlier 4-tier
feature-matrix design (starter/team/enterprise/founding). The pilot price was a flat
$149/mo — too high to get people in the door. This replaces it with a **volume-based
adoption ladder**: a cheap "get-in-the-door" tier whose constraint is loud and obvious
through use, with a frictionless (Stripe) upgrade.

**Re-grounding rule:** file:line references below are non-authoritative provenance. The
invariant + the named function/behavior is the contract — re-ground against current code
before editing.

---

## 1. The pricing model

Four **volume-based** tiers. Tiering is purely quantitative — `seats`, `activeWorkflows`,
`monthlyRuns`. There is **no feature-matrix gating**: every feature (sub-daily schedules,
event triggers, retry/notify, ROI export, all connectors) is available on every plan. You
differentiate on volume, not locked features.

| Plan | Price/mo | Users (`seats`) | **Active workflows** | Runs/mo (`monthlyRuns`) |
|---|---|---|---|---|
| **Solo** (adoption) | $20 | 1 | **1** ← the loud wall | 30 |
| **Professional** | $50 | 1 | 10 | 200 |
| **Team** | $200 | 5 | 50 | 1,000 |
| **Business** | $600 | ∞ | ∞ | 5,000 |
| **Founding** *(internal)* | — | ∞ | ∞ | ∞ | 

- **The loud constraint is `activeWorkflows`.** Owner's call: users feel "I can only run one
  automation at a time" far more than a run cap — a Solo user's single workflow is *editable*
  (real utility), but editing it replaces the previous one, so **multiplicity** is the pain and
  the natural upgrade trigger. The workflow meter is always visible; hitting the wall opens the
  Upgrade modal immediately.
- **`monthlyRuns` is a hard monthly cap** — margin/cost protection ("blocked out for the rest of
  the month"), not the conversion story. Resets on the 1st.
- **`founding`** is an internal, grandfathered unlimited plan — not sellable, not listed in the
  Upgrade modal. Every tenant that existed when this shipped was moved to it (see §5).
- Values live in **`src/entitlements/index.js`** (`PLANS`, `PUBLIC_PLANS`, `PLAN_META`) — the
  single source of truth. Never hardcode per-plan `if`s at call sites.

---

## 2. Entitlements module — `src/entitlements/index.js`

- `PLANS` — the matrix above (`Infinity` = unlimited).
- `entitlement(plan, key)` — value for a plan (falls back to `solo` for unknown plans).
- `seatLimit(plan)`, `nextPlan(plan)` (next sellable tier up, for "Upgrade to X" copy;
  `null` at the top / for `founding`), `entitlementsFor(tenantStore, tenantId)` (resolve a
  tenant's bundle).
- `PlanLimitError` — the uniform gate error: **HTTP 402**, `{ error, code: 'PLAN_LIMIT',
  feature, plan, upgradeTo }`. The UI keys off `code === 'PLAN_LIMIT'` to open the Upgrade modal.

---

## 3. Enforcement points

### 3.1 `activeWorkflows` — the loud gate (publish path)
- **Where:** `POST /api/builder/workflows` (`src/api/builder.js`), before
  `workflowService.create`. This route always creates a NEW workflow (edits go through `PUT`),
  so being at the cap blocks the next publish. **Drafts are unlimited** — only `status:'active'`
  publishes count.
- **Check:** `workflowStore.countActiveForTenant(tenantId) >= entitlement(plan,'activeWorkflows')`
  → **402 `PLAN_LIMIT` `feature:'activeWorkflows'`**. Existing live workflows keep running.

### 3.2 `monthlyRuns` — hard cap (single choke point)
- **Counter:** `tenant_run_counter(tenant_id, yyyymm, count)` in `workflow-store.js`. Incremented
  in `startRun()` for **non-test** runs only, in the same transaction as the run insert. A new
  calendar month is a fresh row — automatic reset, no cron.
- **Gate:** every real run (scheduled, connector-event, and console "run now") funnels through
  `WorkflowScheduler._executeFlow`. A `registerRunBudgetCheck(fn)` hook there skips the run when
  the tenant is over budget (fails **open** on any error). Wired in `server.js` via
  `checkRunBudget({auth, engine}, tenantId)`; each block logs `run.blocked.plan_limit`.
- **Test runs are exempt** — the builder's "Run test" (`POST /workflows/run`, `isTest:true`)
  neither counts nor is blocked, so users can always build/test their one workflow.
- `founding` (∞) never blocks; `business` blocks at 5,000.

### 3.3 `seats` (unchanged mechanism, new limits)
- `GET /api/builder/team` + `POST /api/builder/team/invite` (`src/api/builder.js`) read
  `seatLimit(plan)`. Solo/Professional = 1 (invite blocked → 402 → Upgrade modal); Team = 5;
  Business/Founding = ∞.

---

## 4. Upgrade path — Stripe (self-serve)

- **Module:** `src/billing/stripe.js` — lazy-loads the SDK, env-driven, fails **soft** when
  `STRIPE_SECRET_KEY` is unset (app still boots; checkout returns a clean 503).
- **Routes** (`src/api/server.js`): `POST /api/billing/checkout` (mint a subscription Checkout
  session → returns `url`, browser redirects), `POST /api/billing/portal` (manage/cancel),
  `POST /webhooks/stripe` (signature-verified over `req.rawBody`; flips `tenants.plan` on
  `checkout.session.completed` / `customer.subscription.updated|deleted`, reconciling cancels
  down to `solo`).
- **Env:** `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_{SOLO,PROFESSIONAL,TEAM,
  BUSINESS}` (one recurring monthly price per sellable plan). See `.env.example`. The operator
  fills real values on the box — agents never enter secrets.
- **Tenant linkage:** `tenants.stripe_customer_id` / `stripe_subscription_id`
  (`src/auth/tenant-store.js` `setStripeIds` / `getByStripeCustomer`).

---

## 5. Grandfather migration (one-time)

`tenant-store.js` `init()` runs a marker-guarded migration (`tenant_store_migrations` row
`grandfather_pilot_2026_07`): every existing non-platform tenant is moved to `founding`
(unlimited) so the new caps only bind **new** signups. New tenants default to `solo`. The
guard is a marker row (not plan-name based) because `team` exists in both the old and new
enum — a name-based guard would wrongly re-upgrade real Team customers on every restart.

---

## 6. UI (loud constraint + always-visible upgrade)

`public/index.html` (DC framework):
- **Always-visible Upgrade entry** — a sidebar row (expanded) + rail icon (collapsed), shown
  whenever `nextPlan` exists (hidden for Business/Founding, who have nothing to buy). Turns amber
  with a dot when at the workflow limit.
- **Plan & usage block** in the Account flyout — plan badge + two meters. The **workflows meter is
  the loud one** (turns amber at limit); runs meter secondary with reset date.
- **Upgrade modal** — Solo/Pro/Team/Business cards (price + limits, current plan marked), each
  "Upgrade" button → `/api/billing/checkout` → redirect. Checkout buttons hidden until Stripe is
  configured (`usage.billingConfigured`).
- **Central `PLAN_LIMIT` handler** (`_handlePlanLimit`) — any 402 `PLAN_LIMIT` opens the Upgrade
  modal pre-seeded with the server's feature-specific headline. Hooked into publish + invite.
- **Usage endpoint:** `GET /api/builder/usage` → `{ plan, planLabel, upgradeTo, billingConfigured,
  workflows{used,limit}, runs{used,limit,resetsOn}, seats{used,limit} }` (`limit:null` = ∞).
  Loaded on boot, on account open, and after each publish.

---

## 7. Admin

`src/admin/` — create-workspace plan `<select>` and `.plan-badge` classes updated to
solo/professional/team/business (+ founding, + legacy starter/enterprise badges retained for
any un-rebadged rows). Platform admin can set/override a tenant's plan directly (backstop for
comps / manual moves).

---

## 8. Acceptance tests (fail-closed)

- **Solo** cannot publish a 2nd active workflow (→ 402 `activeWorkflows`, UI auto-opens Upgrade);
  cannot invite a 2nd user (→ 402 `seats`); at 30 runs the next real run is skipped + logged; a
  new month resets. **Can** create/resume unlimited drafts and run tests freely.
- **monthlyRuns** never blocks test runs; a new `yyyymm` bucket resets the budget.
- **Grandfather:** every pre-existing tenant is `founding`/unlimited; migration is idempotent.
- **Stripe:** with test keys, checkout returns a URL; replaying `checkout.session.completed`
  flips the plan; cancel drops to `solo`. Without keys, checkout 503s and the app still boots.
- **Cross-tenant:** run counter + plan are per-tenant; the existing cross-tenant adversarial
  suite stays green.
