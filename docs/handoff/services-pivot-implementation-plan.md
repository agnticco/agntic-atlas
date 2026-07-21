# Services pivot — implementation plan (BUILD-READY)

> **⚠️ NOT BEING EXECUTED — parked 2026-07-21 by operator decision.** Atlas stays exactly the
> product it is; the operator wants to stay open to consulting engagements without committing
> to the pivot. What shipped instead is far smaller and fully reversible: **self-serve signup
> is gated on Stripe being configured** (unset `STRIPE_SECRET_KEY` and the one door closes),
> workspaces are created by hand via `POST /admin/tenants`, and plans are **granted** with
> `setPlan(id, 'business')` — which is already unlimited and already un-buyable. See CLAUDE.md,
> "Self-serve is OFF". This document stays on file as the plan for **if** the pivot is ever
> committed to; its grounding is accurate as of 2026-07-20 and should be re-verified before
> anyone builds from it. In particular **do not execute increment 4 (deleting the Stripe
> surface)** — that is the one irreversible step and it is what would foreclose going back.

**Status: FINALIZED PLAN.** This turns the seed
([`services-pivot-plan.md`](./services-pivot-plan.md)) into a build-ready plan, grounded
against the code as it stands on `feat/plan-gate` (2026-07-20). The seed stays in place as
the record of the locked operator decisions; this doc is what the build follows.

**Scope of THIS pass:** planning + research only. No `src/` changes, no DB changes, no wipe.
Every claim below is grounded with `file:line`. Where the code contradicts the seed, it is
called out under **"Where the seed was wrong."**

**How to read this if you are the operator:** each increment leads with what changes for a
person using Atlas, in plain words. The indented `code:` notes are for the building agent and
can be skipped.

---

## The one-paragraph version

Atlas already does almost everything the services model needs — it just points the levers the
wrong way. Client data is already walled off per client, and a workflow already uses *its own
client's* Slack/Google/Airtable automatically once it's saved. Four things have to change: (1)
the "you've hit your plan limit" walls become an operator switch that is simply **off** for
delivered clients; (2) the person building a workflow (the operator) gets to **choose which
client it belongs to** at the moment they build it — today that's locked to whoever is logged
in; (3) the **builder is hidden from clients** and they see only their monitoring screen; and
(4) the **credit-card checkout is torn out** while the plan column it used is kept and reused as
the grant switch. A one-time **data wipe** clears the pilot slate near the end. The riskiest
change is #2 — letting the operator reach across clients — so it is built as an explicit,
logged, role-locked layer *on top of* the existing isolation, never a hole in it.

---

## Where the seed was wrong (grounding corrections)

These matter because the build order and the risk assessment change with them.

1. **"No caps" already has a vehicle — and there are MORE caps than the seed names.**
   The seed names two caps (`activeWorkflows`, monthly runs). There are in fact **four** cost
   levers, and a granted client must clear all of them:
   - the live-workflow cap at publish — `src/api/builder.js:2313-2324` (also a seat cap,
     `builder.js:806-816`);
   - the monthly run cap in the scheduler — `registerRunBudgetCheck`
     (`src/api/server.js:1001-1010`) → `checkRunBudget` (`src/api/server.js:538-547`);
   - a **build charge** of 1 run-unit on every publish — `chargeRunUnits`
     (`src/api/builder.js:2351-2357`, `BUILD_RUN_COST` `src/entitlements/index.js:84`);
   - a **per-plan daily USD ceiling** in `src/api/tenant-guard.js` (`DAILY_USD_BY_PLAN`, `:35`).
   Good news: the first three already short-circuit when a plan's limit is `Infinity` — the
   publish gate is guarded by `wfLimit !== Infinity` (`builder.js:2315`) and the run gate by
   `ent.monthlyRuns === Infinity` (`server.js:541`); and the code **already ships two uncapped
   plans**, `business` and `internal`, both `Infinity` across the board
   (`src/entitlements/index.js:45,47`). So "granted = no caps" is *reusing the existing plan
   column* exactly as the seed hoped.
   **CONFIRMED MUST-FIX (not just "verify"):** the daily USD ceiling does NOT read `Infinity`
   entitlements — it uses its own per-plan table and **fails CLOSED on an unknown plan**
   (`DAILY_USD_BY_PLAN[plan] ?? DAILY_USD_BY_PLAN.solo`, `tenant-guard.js:56`), and the ceiling is
   only disabled when the value is `0` (`if (DAILY_USD > 0 …)`, `:65`). So a brand-new `client`
   plan that isn't added to that table would **silently inherit Solo's $1/day ceiling and
   hard-block the client's workflows** — the exact silent throttle the operator forbade. Increment
   1 MUST add `client: 0` to `DAILY_USD_BY_PLAN` (0 = no ceiling). The build charge
   (`chargeRunUnits`) never blocks a publish by design (`builder.js:2347-2357`), so it is
   harmless, but confirm nothing reads that counter as a *gate* for a `client` tenant.

2. **The tenant is NOT a free parameter at creation today — it is welded to the login.**
   The seed says "the operator selects the tenant at creation." Today they cannot: the tenant is
   bound into the login token as a verified claim (`claims.tid`, `src/auth/middleware.js:60-66`)
   and the publish route hardcodes the caller's own tenant
   (`tenantId: req.tenant.id`, `src/api/builder.js:2330`). So this is **net-new privileged
   capability**, not a UX toggle over something that exists. This is increment 3 and it is the
   security-critical one.

3. **Connector grants already follow the workflow's stored client — at RUN time. But NOT at
   BUILD/TEST time.** At run time every path re-derives credentials from the workflow's stored
   `tenant_id` (`injectTenantTokens(wf, wf.tenant_id, …)`, `src/api/server.js:953`), so a
   correctly-stamped workflow automatically uses the right client's Slack/Airtable/Google —
   confirmed, and it is why increment 3 is mostly "stamp the right id." **But the in-builder
   "Run test" and the chat both resolve connectors from `req.tenant.id`** (e.g.
   `getSlackToken({ …, tenantId: req.tenant.id })`, `src/api/builder.js:1357`). So an operator
   building *for client X* would test against the **operator's own** Slack, and the converger's
   "which channels are connected" catalog (which drives `CHANNELS_UNVERIFIED` / the gap check)
   would describe the operator, not the client. **Increment 3 must thread the selected tenant
   through the build/test/chat path too, or the operator builds against the wrong reality.** The
   seed does not mention this.

4. **There is no role gate on the builder today.** The seed's "split by role" reads as
   tightening an existing split; there isn't one. Builder and console routes are both only
   `requireActiveTenant` (`mountBuilderRoutes` / `mountConsoleRoutes`,
   `src/api/server.js:2612-2613`). Roles today are just `admin`/`user` *within* a tenant
   (`src/auth/middleware.js:86-90`); `requirePlatformAdmin` is admin-in-the-`platform`-tenant
   (`middleware.js:111-116`). So an "operator can build / client cannot" distinction is new
   construction (increment 2), and it is a **prerequisite** for increment 3's security.

5. **The Stripe surface is bigger than the three routes the seed lists.** Full surface to
   remove: `POST /api/billing/checkout` (`server.js:2471`), `POST /api/billing/portal`
   (`server.js:2521`), `POST /api/signup/checkout` (`server.js:2537`), `POST
   /api/billing/resubscribe` (`server.js:2568`), `POST /webhooks/stripe` (`server.js:2595`), the
   module `src/billing/stripe.js`, and the front-end Upgrade modal in `public/index.html`. Also
   **the `/admin/sales` feed goes dead** when Stripe is removed — it is fed by Stripe billing
   events (`src/admin/server.js:324`, `spine.billingEvents`) — so that admin tab is a decision,
   not an automatic keep. The seed said keep the plan + `stripe_*` columns
   (`src/auth/tenant-store.js:23,68-73`) — correct, keep them.

6. **The client-tenant creation flow the seed's onboarding question asks for ALREADY EXISTS.**
   `POST /admin/tenants` (`src/admin/server.js:77-122`, platform-admin gated) creates the tenant,
   mints the first admin, and emails a 7-day set-password invite link. The open question is not
   "how do we create a client tenant" — it's "how do that client's connectors get authorized,"
   answered below.

Everything else in the seed is confirmed accurate.

---

## The onboarding recommendation (the seed's "REQUIRES RESEARCH")

**Recommendation: the client authorizes their own tools, on their own consent screens, into
their own walled-off space — reached through a one-time "connect your tools" link the operator
sends. The operator never holds the client's passwords or tokens.**

**What the client experiences.** The operator creates the client's workspace and the client's
admin gets an email invite (this already works). They set a password, log in once, and land on a
plain "Connect your tools" screen — Slack, Google, Airtable, each a single button. Clicking one
sends them to that vendor's own approval screen ("Agntic Atlas wants to post to your Slack —
Allow?"). They approve, and they're done. They never see the builder. From then on the operator
builds and runs their automations for them.

**Why this is the right pattern (not the alternatives).**
- It is what Atlas is already built for. A connector token is stored **scoped to the approving
  client's workspace**, and the trust anchor is the OAuth `state` bound to that workspace when
  the button is clicked (`src/api/server.js:1827` issues it, `:1834-1847` stores the token under
  `grant.tenantId`; the same shape for Airtable `:2340-2360` and Google `:2017-2036`). The token
  lands in the client's vault; the operator's login is never involved.
- It matches outside best practice. Per-tenant tokens in an isolated vault, with the tenant id a
  *verified token claim and never client-supplied*, is the endorsed multi-tenant pattern — and
  Atlas already does exactly this (`claims.tid`, `middleware.js:60-66`). Delegated user/admin
  consent (the client clicks "Allow" on their own screen) is preferred over the operator holding
  a service account or domain-wide delegation, which the guidance says to avoid unless there's a
  critical need. (Sources below.)

**The one wrinkle, and why it's acceptable.** The client has to click "Allow" once per tool. The
only way to avoid that is to have the operator do it for them — which means the client hands over
admin credentials or sets up domain-wide delegation, so **Agntic ends up holding the client's
keys.** That is a credential-custody and audit liability, and if a token leaks the blast radius
is the client's whole workspace, with Agntic named as the holder. The one-time click keeps the
key in the client's control and the blast radius one workspace. The small friction is the
correct trade.

**What this means for the build.** Onboarding needs **no new OAuth mechanism** — it reuses the
existing per-tenant connect flow. It needs:
- a **client-role landing surface** that shows only "connect your tools" + the monitoring
  console (part of increment 2's role split);
- optionally, a nicer **operator-initiated "connect link"** so the operator can send "click here
  to connect your Slack" directly, rather than routing the client through a full login first
  (a thin wrapper over the existing invite-token + `/connectors/*/authorize` flow — a
  nice-to-have, not required for correctness).

> **Operator decision still needed here:** whether Google Workspace clients will use per-user
> OAuth consent (recommended, what the code does) or whether any client will demand
> domain-wide delegation (an admin-installs-once model). Recommend defaulting to per-user
> consent and only revisiting if a specific enterprise client requires otherwise — it is a
> heavier, higher-trust setup Atlas is not currently wired for.

Sources: [Multi-tenant SaaS token isolation (Albato)](https://albato.com/blog/publications/embedded-multi-tenant-mcp-saas),
[Scaling multi-tenant auth (Peerlist)](https://peerlist.io/jagss/articles/multitenancy--authentication-how-it-works-under-the-hood),
[Google domain-wide delegation best practices](https://knowledge.workspace.google.com/admin/apps/domain-wide-delegation-best-practices),
[Google: control API access with domain-wide delegation](https://knowledge.workspace.google.com/admin/apps/control-api-access-with-domain-wide-delegation).

---

## The build, increment by increment

Serial, one deliverable each, per the CLAUDE.md working rules. Branch each off `main`, PR,
squash-merge; do not start the next until the previous is merged. The marketing site (seed #6)
runs in parallel in its own repo and is not on this critical path.

### Increment 1 — Turn the paywall into a grant switch

**What changes for people:** delivered clients never hit a wall — no "you can only run 1
workflow," no "you're out of runs this month," ever. A workspace nobody has granted stays capped
(the caps become a dormant artifact, not a live paywall).

**Plan-language design.** Introduce one new plan value that means "granted client — no limits of
any kind." New client workspaces the operator sets up are put on it. Un-granted workspaces keep
the existing capped default, so nothing can run wild by accident.

**Recommendation:** add a **new `client` plan** = `Infinity` everywhere, rather than overloading
`business` (which carries "consultative / talk-to-sales" meaning and drives Stripe copy) or
`internal` (which means "Atlas's own workspace"). A distinct name keeps the audit trail honest —
a row on `client` visibly means "a delivered client," not "a sales lead" or "us."

    code:
    - src/entitlements/index.js — add `client: { seats: Infinity, activeWorkflows: Infinity,
      monthlyRuns: Infinity }` to PLANS (:36). It is NOT self-serve, so it stays out of
      SELF_SERVE_PLANS (:64) and satisfies the `unlimited ⇒ not self-serve` invariant in
      scripts/checks/tier-caps.mjs. Do NOT add it to PUBLIC_PLANS/PLAN_META (never rendered on a
      pricing page).
    - src/auth/tenant-store.js — add 'client' to VALID_PLANS (:34) so setPlan/create accept it.
    - MUST: add `client: 0` to DAILY_USD_BY_PLAN (tenant-guard.js:35) — 0 disables the ceiling
      (:65). Omitting it makes `client` fall through to the fail-closed Solo default ($1/day,
      tenant-guard.js:56) and hard-block the client. This is the one lever that does NOT read the
      Infinity entitlements and will silently throttle if missed.
    - The publish build-charge (builder.js:2351 chargeRunUnits) never blocks by design; confirm
      nothing else reads that counter as a gate for a `client` tenant.
    - Granting = tenants.setPlan(id, 'client') (tenant-store.js:165), reachable from the admin UI
      (admin/server.js already has the tenant surface). No new gate machinery.

**Adversarial/acceptance:** an un-granted tenant still gets the 402 wall (the machinery is
dormant, not deleted); a `client` tenant publishes an Nth workflow and runs past the old monthly
number with no block, no silent throttle. This is the increment that most directly serves the
CLAUDE.md rule that a delivered client must never be silently throttled mid-month.

### Increment 2 — Split builder (operator) from console (client) by role

**What changes for people:** clients can only ever see their monitoring/console screen — run
history, the promise/test panel, the SOP. The builder simply isn't there for them. The operator
sees the builder. This is enforced by the server, not by hiding a button.

**Plan-language design.** Add an **operator capability** distinct from "tenant admin." A client's
own admin is still an admin *of their workspace* (they can connect tools, manage their seat) but
is **not** an operator and cannot reach the builder or the tenant picker. The operator capability
lives on the operator's account (in the `platform`/`agntic` internal tenant).

    code:
    - Reuse the existing platform-operator notion: requirePlatformAdmin already means "admin in
      the platform tenant" (middleware.js:111-116). Cleanest path: define `requireOperator`
      (operator = platform-tenant admin, or a new user capability flag if the operator wants
      non-platform operators later) and gate the builder mutation + chat + tenant-select routes
      with it, ON TOP of requireActiveTenant.
    - mountBuilderRoutes (server.js:2612) — the build/chat/publish routes get requireOperator.
      The client-facing reads (console, connector connect/status, inbox) stay requireActiveTenant
      so a client can still connect tools and watch runs.
    - public/index.html — hide the builder surface for non-operators (defense-in-depth; the
      server gate is the real boundary).
    - This is the PREREQUISITE for increment 3: the tenant picker must be operator-only, and
      that needs the operator role to exist first.

> **Operator decision:** will there ever be an operator who is NOT in the platform tenant (e.g. a
> contractor delivering for Agntic)? If no (likely for now), operator == platform admin and this
> is nearly free. If yes, add a `capabilities`/`is_operator` flag on the user row. Recommend
> starting with operator == platform admin and adding the flag only when a real second operator
> exists.

### Increment 3 — Tenant-at-creation: the privileged, audited cross-client layer

**What changes for people:** when the operator builds a workflow, they first pick which client
it's for. The workflow is stamped to that client and shows up in that client's console, running
on that client's connected tools. A normal user can never see or use this picker.

**This is the security-critical increment.** It is an explicit, logged, role-locked layer *above*
the isolation — it must never loosen the isolation itself.

**Plan-language design.**
- The tenant picker and the "build for tenant X" capability are **operator-only** (increment 2's
  gate).
- Choosing a client is an **explicit, audited action**: every time the operator stamps a workflow
  to a client that isn't their own login tenant, it's written to the event log with the operator's
  id and the target client — so there's a record of who built what for whom.
- The isolation stays exactly as it is. Stores still throw on a missing tenant; a client's login
  still can't reach another client. The only new power is narrow: *the operator, and only the
  operator, may name the target client on the create path.*

    code:
    - The create path (POST /api/builder/workflows, builder.js:2300) currently forces
      tenantId: req.tenant.id (:2330). Add an OPTIONAL `targetTenantId` in the body, honored ONLY
      when requireOperator passed. Introduce a single choke function, e.g.
      `resolveBuildTenant(req)`: if a targetTenantId is present AND req is an operator AND the
      target tenant exists and isActive → use it and logEvent('operator.cross_tenant_stamp',
      { operator, target }); otherwise fall back to req.tenant.id. A non-operator supplying
      targetTenantId → 403, no row created. NEVER derive the target from unauthenticated/client
      input.
    - New operator-only endpoint to list selectable tenants for the picker (wraps
      tenants.list(), tenant-store.js:204) — gated requireOperator.
    - THREAD THE SELECTED TENANT THROUGH BUILD/TEST/CHAT (the correction #3 above): the
      test-run connector injection and the chat connector catalog currently key off
      req.tenant.id (builder.js:1357 and the dry-run path). When an operator has selected client
      X, the "Run test", the chat's connected-connector context, AND the converger's channel
      catalog (which feeds CHANNELS_UNVERIFIED / the gap check) must resolve client X's grants —
      otherwise the operator tests against their own Slack and the promise check certifies against
      the wrong connector reality. Route the selected tenant into these the same way as the stamp.
    - Run-time is already correct: injectTenantTokens(wf, wf.tenant_id,…) (server.js:953) uses the
      STORED tenant, so a correctly-stamped workflow already runs on client X's grants and lands
      in client X's console. No run-path change needed beyond confirming it.

**The adversarial test this needs (same rigor as the isolation tests):**
1. A normal `user` and a workspace `admin` (non-operator) POST a workflow with
   `targetTenantId` = another tenant → **403, and no workflow row is created** in either tenant.
2. A non-operator calling the tenant-list/picker endpoint → **403**.
3. The operator stamps a workflow to client X → the stored row has `tenant_id = X`, it appears
   ONLY in X's console, and a run resolves **X's** Slack/Airtable/Google grants, never the
   operator's (assert the injected token is X's).
4. With client X selected, an in-builder **test run** resolves **X's** connectors, and the
   converger's channel catalog reflects **X's** connections — not the operator's. (This is the
   correction-#3 guard; without it the whole promise check is certifying the wrong reality.)
5. Stamping to a non-existent or archived tenant → rejected, no row.
6. Every cross-tenant stamp is in the event log with operator id + target tenant.

### Increment 4 — Remove the Stripe checkout surface (keep the columns)

**What changes for people:** there's no "upgrade / add a card" anywhere. Nothing about how
clients are granted changes — that's increment 1's operator switch now.

**Plan-language design.** Delete the checkout surface cleanly; keep the `plan` and `stripe_*`
columns (increment 1 reuses `plan` as the grant flag; the `stripe_*` columns are harmless dormant
history). Do this **after** increment 1 so nothing that grants access depends on Stripe.

    code — remove:
    - Routes: /api/billing/checkout (server.js:2471), /api/billing/portal (:2521),
      /api/signup/checkout (:2537), /api/billing/resubscribe (:2568), /webhooks/stripe (:2595).
    - Module src/billing/stripe.js and its imports in server.js (:96 region).
    - handleStripeLifecycle wiring + spine.billingEvents feed if it becomes orphaned.
    - Front-end Upgrade modal + any PLAN_LIMIT→upgrade CTA in public/index.html (the 402 path can
      stay as a dormant server response; the client-facing upsell UI goes).
    code — KEEP:
    - tenant-store.js plan column (:23), stripe_customer_id/stripe_subscription_id (:68-73),
      setStripeIds/getByStripeCustomer (:177-193) — dormant, not in the way.
    - The grandfather/retire-founding migrations (:81-124) — historical, leave untouched.

> **Operator decision:** the `/admin/sales` tab (admin/server.js:324) is fed by Stripe billing
> events and goes dead with Stripe gone. Recommend **removing the sales tab** in this increment
> (it measures self-serve MRR, which no longer exists) while keeping the **cost** dashboard
> (increment-5 keep). Confirm.

### Increment 5 — Admin cost dashboard: keep, optionally restyle

**What changes for people:** unchanged for the operator — the cross-client cost view stays. Only
a visual refresh is optional.

    code: src/admin/server.js already reads llm_cost_log for per-tenant + system cost
    (_tenantRunMetrics :488, _tenantCostMetrics, /admin/tenants/:id/cost :192, /admin/usage :261).
    Functionally complete; no backend change required. Restyle public admin/index.html only if
    desired. (This "increment" is really a no-op-with-optional-polish; listed so the plan is
    complete.)

### Increment 6 — The production data wipe (near-final, gated)

**What changes for people:** the pilot slate is cleared for the services era. This is
destructive and one-way; it runs only after the pre-wipe checklist passes and **only after
increments 1–4 are merged** (wiping onto old gating code just re-creates the problem).

    code / operational — this is NOT part of this planning pass and must not be run now.
    Databases in scope (all under ./memory/ on the box — CONFIRM the live paths against
    src/api/server.js DB-path constants at wipe time, they may have moved):
    - auth.sqlite (users/tenants/sessions), workflows/workflows.sqlite + idempotency.sqlite,
      oauth.sqlite, per-tenant RAG stores, sources.sqlite, interactions.sqlite, inbox.sqlite,
      tickets/, approvals store, and the llm_cost_log.
    - ALSO clear the tenant_run_counter table (workflow-store.js:264) so no stale monthly count
      survives.
    Pre-wipe checklist (MUST, in order — from seed #7, still current):
    1. Enumerate live tenants/users on atlas.agntic.co; notify/offboard or confirm none remain.
    2. Full dated off-box backup, and PROVE it restores. (The pre-purge 148-row backup is NOT a
       current backup.)
    3. Preserve the operator's own platform/agntic tenant + admin account (INTERNAL_TENANT_IDS
       defaults to 'agntic', tenant-store.js:43), or have ensureBootstrap's setup-token path ready
       — else the operator is locked out of the app they just reset.
    4. Decide seed rows after the wipe: does the operator want their own operator account +
       platform tenant re-created, and any first client tenant pre-seeded, or start truly empty?

---

## Operator decisions still needed

1. **Tenant selector: creation only, or also edit-an-existing-workflow under a client?** The
   operator said "select at creation time." **Recommendation: build the operator's tenant context
   so it also covers editing an existing client workflow** — editing a live client automation is a
   normal delivery task, and forcing a rebuild-to-fix would be worse. The same role-gated,
   audited mechanism from increment 3 covers both; the picker just also applies when opening an
   existing workflow. Cost of getting this wrong is low (it's additive), so recommend yes unless
   the operator wants creation-only for a tighter first cut.

2. **Confirm: no caps on granted (`client`) accounts, EVER** — recorded as intent in the seed,
   needs a definite yes. Recommendation: yes, via the `client` = Infinity plan (increment 1); a
   run cap that silently throttles a paying client mid-month is exactly the silent-failure class
   this codebase exists to prevent.

3. **Onboarding: default to per-user OAuth consent (client clicks "Allow" on their own screen)?**
   Recommendation: yes (see the onboarding section). Only revisit domain-wide delegation if a
   specific enterprise client demands it.

4. **Operator identity: is "operator" always "platform-tenant admin," or will there be operators
   outside the platform tenant?** Recommendation: start with operator == platform admin (nearly
   free); add an `is_operator` user flag only when a real second operator exists (increment 2).

5. **Remove the `/admin/sales` (self-serve MRR) tab when Stripe goes?** Recommendation: yes;
   keep the cost dashboard (increment 4/5).

6. **Post-wipe seed:** start truly empty, or pre-seed the operator account + first client tenant?
   (increment 6, checklist step 4.)

7. **Build order — confirm.** Proposed and recommended:
   **1) grant switch → 2) role split → 3) tenant-at-creation (depends on 2) → 4) Stripe removal
   (after 1) → 5) admin cost keep/polish → 6) data wipe (after 1–4).** Marketing site runs in
   parallel, off-path.

---

## What must NOT be weakened (carried from the seed, still binding)

- Tenant isolation stays fail-closed and structural (stores throw on missing tenant). The
  operator's cross-client reach is the explicit, audited, role-gated layer of increment 3 —
  never a loosening of the isolation, and proven by the adversarial test listed there.
- The connector **catalog** is app-wide (already is); connector **grants/tokens** stay
  per-client and isolated. Stamping a workflow to the wrong client = one client's automation
  posting into another's Slack — this is the failure the increment-3 adversarial test exists to
  prevent.
- The promise / test-panel rigor is a SERVICES asset (it proves delivery to a paying client). Do
  not strip it as "self-serve overhead."
- `LLM_INPUT_NOT_ENUM` and `EMAIL_REPLY_APPROVAL` (CLAUDE.md) are never weakened.

---

## Grounding index (file:line)

- Entitlements / caps: `src/entitlements/index.js:36,45,47,64,82,84,131`
- Daily USD ceiling (fails closed on unknown plan): `src/api/tenant-guard.js:35,56,65`
- Publish cap + build charge: `src/api/builder.js:2313-2357`; seat cap `:806-816`
- Run-budget gate: `src/api/server.js:1001-1010,538-547`
- Tenant bound to login: `src/auth/middleware.js:60-66,86-90,111-116`
- Workflow create stamps tenant: `src/api/builder.js:2300-2331`; service `src/workflows/workflow-service.js:83-123`
- Run-time grant resolution (correct): `src/api/server.js:349-430,953`
- Build/test/chat grant resolution (needs threading): `src/api/builder.js:1355-1358`
- Per-tenant token storage + OAuth state anchor: `src/api/server.js:1824-1848` (Slack),
  `:2017-2036` (Google), `:2340-2360` (Airtable); `src/connectors/slack/oauth.js:149-172`
- Client-tenant creation + invite (exists): `src/admin/server.js:77-122`
- Stripe surface: `src/billing/stripe.js`; routes `src/api/server.js:2471,2521,2537,2568,2595`
- Plan/stripe columns to KEEP: `src/auth/tenant-store.js:23,68-73,177-193`
- Admin cost dashboard (keep): `src/admin/server.js:192,261,488`; sales feed (dies) `:324`
- Test runs exempt from counting: `src/workflows/workflow-store.js:910-941` (isTest skips counter)
