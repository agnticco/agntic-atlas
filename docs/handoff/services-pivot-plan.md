# Services pivot — refactor & remarketing plan (SEED)

**Status: SEED, not the plan.** This document captures the decisions and constraints
locked with the operator on 2026-07-20. The *next session's job is to turn this into the
full plan* — with the sub-plans and a build order — and then this file becomes that plan.
Until then, treat everything below "Open questions" as unresolved.

**Point the next agent here.** This is the directable artifact; the operator's private
session memory mirrors it but is not something another agent can read.

---

## The shift (why any of this)

Agntic is now a **workflow-automation professional-services firm**; Atlas is the
**internal delivery platform**, not a self-serve SaaS. The operator builds and runs client
workflows on Atlas; clients see a monitoring surface, never the builder. No self-serve
signups. Full GTM rationale is in the operator's memory (`gtm-services-first`,
`gtm-positioning-language`, `gtm-services-pricing`) — the short version: services-first is
the model that is executable today and funds the option on a product later; do not refactor
broadly on speculation ahead of real client engagements.

**Guiding caution:** the engine, converger, control flow, promise system and connectors do
not care whether the driver is a customer or the operator. Most of the product does NOT
change. Change only what the delivery model actually forces.

---

## Locked decisions (operator, 2026-07-20)

### 1. Tier gating: paywall → operator GRANT
- Eliminate gating as a **paywall**. Keep the **Solo tier** as the *shape of a granted
  product account* the operator hands to specific people. No self-serve.
- The machinery is not deleted — its **trigger inverts**: from "blocked until Stripe says
  paid" to "off for everyone, ON where the operator grants access."
- **Granted accounts have NO caps** — not `activeWorkflows` (1 on Solo today), not the
  monthly run cap. A run cap on a delivered client silently throttles their workflows
  mid-month — the exact silent-failure class this codebase exists to prevent. Caps remain
  only as dormant artifacts for a hypothetical future self-serve user.
- Touch points: `src/entitlements/index.js` (`PLANS`/`entitlementsFor`), the 402
  `PLAN_LIMIT` at `POST /api/builder/workflows`, `WorkflowScheduler.registerRunBudgetCheck`,
  `src/auth/tenant-store.js` plan enum.

### 2. Cross-tenant operator access — via tenant-at-creation, NOT a super-view
The operator's model (this REPLACES the earlier "operator super-view" framing and is much
smaller/safer):
- The **builder is operator-facing.** At **workflow creation time the operator selects the
  tenant.** The workflow is stamped with that `tenant_id`, which routes it into that
  client's dashboard surface. A "builder client" concept: workflows are tenant-connected at
  creation and pushed to the client-facing dashboard.
- Isolation for **workflows, connections, and cost STAYS** (operator requirement). Stores
  keep throwing on a missing tenant. The privileged capability is narrow: *choosing which
  tenant a workflow belongs to*, operator-role-gated on the create path.
- **CATALOG vs GRANTS — do not conflate (credential-leak risk).** The connector *catalog*
  (which capabilities exist) is app-wide and already is. The connector *grants* (a client's
  actual OAuth tokens) are **per-tenant and must stay isolated**. A workflow stamped to
  tenant X must resolve tenant X's grants (`injectTenantTokens` / `CONNECTOR_INJECTORS` /
  `getSlackToken` et al.), never the operator's. Stamping the wrong tenant = one client's
  workflow posting into another's Slack.
- Still needs its own adversarial test (a normal user must never reach the tenant-select or
  another tenant's data), same rigor the isolation itself got.

### 3. Console/builder split enforced by ROLE
Clients get monitoring, run history, promise/test panel, SOP. Operator keeps the builder.
Make it a **permission**, not a sales convention.

### 4. Remove Stripe — in TWO moves, not one
- Remove the checkout **surface**: `src/billing/stripe.js`, `/api/billing/checkout|portal`,
  `/webhooks/stripe`. Clean.
- Do **NOT** in the same swing touch the tenant `plan` / `stripe_*` columns or the
  grandfather migration — decision #1's grant model likely **reuses the plan column as the
  grant flag**. Repurpose, don't drop.

### 5. Admin dashboard — KEEP, maybe restyle
`src/admin/{server.js,index.html}` already shows cross-tenant cost (`_tenantRunMetrics`,
reads `llm_cost_log`) and is the operator's cost view. Keep it. UI design may be upgraded;
functionally it already does what the operator needs.

### 6. Marketing site reframe — SUB-PLAN WRITTEN, ready to execute
Independent of all product work; ships on its own to unblock outbound. Full sub-plan:
[`marketing-site-services-reframe.md`](./marketing-site-services-reframe.md). Decisions locked
2026-07-20: Agntic-firm framing (Atlas as engine, keep `atlasbyagntic.com`); no public pricing
(book-a-call); no waitlist; **fast reframe first**, not a redesign. Repo is separate:
`/Users/crepps/Desktop/AGNTIC/website/atlas-landing`. The July-30 self-serve pricing flip is
now **obsolete**.

---

### 7. Fresh-start DATA WIPE (operator, 2026-07-20) — DESTRUCTIVE, do not run un-scoped
Scope confirmed **production DATA only**: clear existing tenants, workflows, users, runs,
OAuth tokens, RAG datastores, tickets, cost logs — a clean client slate for the services
era. **The codebase STAYS and is refactored in place** (this is not a codebase rebuild).
- **Not yet executed. It is a planned step, gated on the pre-wipe checklist below.**
- Databases in scope (all under `./memory/` on the box): `auth.sqlite` (users/tenants/
  sessions), `workflows/workflows.sqlite` + `idempotency.sqlite`, `oauth.sqlite`, per-tenant
  RAG stores, `sources.sqlite`, `interactions.sqlite`, `inbox.sqlite`, `tickets/`, the
  `llm_cost_log`. Confirm the full list against `src/api/server.js` DB path constants at
  wipe time (they may have moved).
- **Pre-wipe checklist (MUST, in order):**
  1. **Confirm who is live.** The operator flagged, and accepted, that any real pilot user on
     atlas.agntic.co loses access and their running automations stop. Before the wipe:
     enumerate live tenants/users and either notify/offboard them or confirm none remain.
  2. **Take a full, dated backup off-box** and verify it restores — a wipe with no proven
     restore is a one-way door. (A pre-purge 148-row backup already exists per the handoff
     findings; do not rely on it as the current backup.)
  3. **Preserve the operator's own admin/platform account + tenant**, or have a re-bootstrap
     path ready (`ensureBootstrap` mints a setup token on an empty auth DB) — otherwise the
     operator is locked out of the app they just reset.
  4. Decide whether the grant model (#1) + tenant plan columns (#4) need any seed rows after
     the wipe, or start truly empty.
- **Sequencing:** the wipe should come AFTER the grant/tenant/Stripe refactor lands, not
  before — otherwise it's wiped twice, and a wipe onto old gating code re-creates the
  problem being removed. Treat it as a near-final step of the pivot, not the first.

## Open questions for the next session
1. **Tenant selector UX** — a picker on the create path only, or does the operator also need
   to *view/edit an existing* workflow under a given tenant? (Operator said "select at
   creation time"; confirm whether post-creation cross-tenant editing is also needed.)
2. **Confirm: no caps on granted accounts, ever** (recorded as intent, needs a definite yes).
3. **Grant/onboard flow — REQUIRES RESEARCH (operator, 2026-07-20).** How does a new client
   tenant get created and its connectors authorized in a SERVICES shape (operator delivering)
   rather than a PRODUCT shape (user self-connecting)? Undetermined; the operator wants the
   best operational pattern researched before it's designed — e.g. onboard on the client's
   own admin consent screen vs. a delegated setup the operator performs. This is a genuine
   open design/research task, not a decision waiting to be written down.
4. **Build order** — proposed: (1) small/unblocking = kill the paywall + grant model;
   (2) tenant-at-creation + role-gated split; (3) Stripe surface removal; the marketing site
   in parallel, independent; (4) the data wipe as a near-FINAL step (see #7). Confirm.

## What must NOT be weakened
- Tenant isolation stays fail-closed and structural. The operator's reach is an explicit,
  audited, role-gated layer ABOVE it — never a loosening of it.
- The promise/test-panel rigor is a SERVICES asset (proves delivery to a paying client). Do
  not strip it as "self-serve overhead."
- `LLM_INPUT_NOT_ENUM` and `EMAIL_REPLY_APPROVAL` (CLAUDE.md) are never weakened.
