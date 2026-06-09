# Multi-tenancy & data isolation

**Decision (2026-06-09):** Atlas is multi-tenant from the foundation. This reverses
the earlier "no per-org tenancy in the pilot" closed decision. Each onboarding
client is a **tenant**; users and every resource live underneath a `tenant_id`.

The load-bearing requirement: **one tenant's data must never surface in another's.**

## Model

- **Tenant** is the top-level entity (`tenants` table). Every user belongs to exactly
  one tenant. Every tenant-owned row (sessions, OAuth tokens, workflows, runs,
  versions, feedback, RAG documents) carries the owning `tenant_id`.
- **Roles:**
  - `platform_admin` — us, the operator. Lives above tenants; can create/suspend
    tenants and provision their first admin. The first-run bootstrap creates the
    platform admin.
  - `admin` / `user` — scoped *within* a tenant.
- **JWT** carries `tid` (tenant id) alongside `sub`/`jti`/`role`. Middleware resolves
  `req.tenant` from the token and enforces that the session row's `tenant_id` matches
  the claim. Every request operates inside exactly one tenant (platform-admin routes
  are the only cross-tenant surface, and they are explicit).

## Isolation strategy

Two regimes, chosen per data sensitivity:

### Shared DB + bound tenant-scoping layer (auth, vault, workflows)

One set of SQLite files; every tenant-owned table gains a `tenant_id` column
(additive `ALTER`, mirroring the existing `user_id` migration). Isolation is enforced
**structurally**, not by remembering a `WHERE`:

- **Fail-closed stores.** Store methods *require* a tenant. A missing tenant
  **throws** — the old "`userId === undefined` ⇒ return all rows" behaviour is gone.
  Forgetting the scope is an error, never a silent leak.
- **Bound facade.** `stores.forTenant(tenantId)` binds the tenant once at the request
  boundary; the rest of the app calls the bound API and physically cannot omit the
  tenant. Raw, unbound store access is removed from request paths.
- **Explicit system paths.** The few legitimately cross-tenant operations (the
  scheduler's `getDue`) are *named* as such and re-bind to each workflow's own tenant
  before executing or touching tenant data.

### Per-tenant physical isolation (RAG / company context)

RAG holds company context — the highest-sensitivity data — so it is **physically**
isolated, not merely filtered. Each tenant gets its **own RAG datastore/connector**:
`ragForTenant(tenantId)` resolves a dedicated, isolated store (its own backing
path/connection), cached per tenant. There is no shared vectors table and no
cross-tenant query is even expressible. The resolver is pluggable so a tenant's RAG
"connector" can later point at a dedicated external store without changing callers.
`/rag/*` requires auth (no anonymous path) and derives the tenant from the request.

## Proof

Isolation is verified by an **adversarial cross-tenant test suite** + a gate
(`scripts/gates/cap-multitenancy.sh`, closed by a fresh Verifier): tenant A cannot
read/list/update/delete/run tenant B's users, sessions, vault tokens, workflows,
runs, or RAG documents; the same email in two tenants stays separate; and a
missing-tenant call throws (fail-closed). Isolation is a tested invariant, not a
convention.

## Scope of the first PR

Multi-tenancy foundation + management endpoints + per-tenant RAG, as one PR (tagged
Phase 1). The Slack connector's OAuth (user-authorization) refactor is the next
deliverable — it stores tokens in the now-per-tenant vault, so it depends on this.

## Notes / forward-compat

- The tenant-scoping layer is DB-engine-agnostic; it survives a future move off
  SQLite (e.g. Postgres) for the shared stores.
- Existing single-user pilot data migrates under a `default` tenant.
