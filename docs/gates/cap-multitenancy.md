# Gate: cap-multitenancy — Multi-tenant data isolation (foundational)

**Verdict: PASS**
**Date:** 2026-06-09
**HEAD:** abcd06405d458c05963de05266709ee829ec9749 (branch `feat/p1-multitenancy`)
**Verified-by:** independent Verifier (did not write the code)

The load-bearing requirement: one tenant's data can NEVER surface in another's.
Verified structurally (code review) AND adversarially (the bundled gate plus the
Verifier's own throwaway attack scripts, run against the live HTTP surface).

## 1. Tree state
- `git status --porcelain` → empty (clean) before and after verification.
- HEAD `abcd064` on `feat/p1-multitenancy`. (Note: no git tag points at HEAD;
  "Phase 1" is recorded via the `Phase: 1` commit trailers, not an annotated tag.)
- Closed-decision reversal recorded: ENGINEERING-LOG.md:21-29 ("Multi-tenant from the
  foundation … reverses the earlier 'no tenancy in pilot' decision, 2026-06-09").
- Approved salvage edits recorded: ENGINEERING-LOG.md:54-64.

## 2. Objective gates (all exit 0)
- `bash scripts/gates/cap-multitenancy.sh` → exit 0; all 4 sub-checks PASS
  (auth/vault scoping, workflow-store scoping, RAG per-tenant isolation, HTTP
  cross-tenant attacks incl. suspension lockout).
- `bash scripts/gates/p0.sh` → exit 0 (engine+auth boot, /health 200, server.js
  clean UTF-8). Run after `rm -rf ./memory`.
- `bash scripts/gates/p1.sh` → exit 0 (hand-authored spec ran through engine →
  Slack). No regression.
- Gate script `scripts/gates/cap-multitenancy.sh` is honest and fail-closed: it
  runs 4 real node checks and greps for explicit PASS markers, failing if absent.
  Not weakened.

## 3. Structural isolation (code review)
- **Auth stores fail-closed:** `UserStore.list/findByIdInTenant/update/disable/
  enable/delete/countForTenant/create` all call `requireTenant()` which throws on
  a missing tenant (src/auth/user-store.js:43-48,112,140,152,169,222,244,251,259).
  Email is GLOBALLY UNIQUE (user-store.js:25) so login resolves tenant; `findById/
  findByEmail/count` are deliberately global, with tenant cross-checked downstream.
  Additive `_migrateTenantId` backfills 'default' (user-store.js:85-92).
- **Vault fail-closed:** `OAuthTokenStore.get/upsert/delete/updateTokens` all call
  `requireTenant()` and filter `AND tenant_id = ?`
  (src/auth/oauth-token-store.js:41-46,90,122,136,146).
- **Middleware (src/auth/middleware.js):** `tid` claim REQUIRED (line 52);
  session row's `tenant_id` must equal the claim (line 60); user row's
  `tenant_id` must equal the claim (line 64). A token cannot act in a tenant it
  was not issued for. `requirePlatformAdmin` gates the only cross-tenant surface
  (lines 111-116). `TokenService.sign` requires + embeds `tid` (token-service.js:
  85-87). `issueSession` is the single mint point, stamping tenant into both
  session and token (src/auth/index.js:97-102).
- **Tenant suspension enforcement (server.js):** `requireActiveTenant` runs
  requireAuth then 403s if `tenantStore.isActive(req.tenant.id)` is false
  (src/api/server.js:242-247); `/auth/login` also 403s a suspended tenant
  (line 267). `setStatus` refuses to suspend the platform tenant (tenant-store.js:102).
- **RAG physical isolation (src/api/server.js):** `forTenant(tenantId)` throws on
  no tenant (line 137) and resolves a DISTINCT per-tenant sqlite path
  `VECTOR_DIR/<sanitized-tenantId>/company.sqlite` (lines 128-133, path-traversal
  sanitized). No shared vectors table; cross-tenant query is not expressible.
  `/rag/ingest` + `/rag/query` are gated by `requireActiveTenant` and scoped to
  `req.tenant.id` (lines 315-347).
- **Workflow store:** `tenant_id` on workflows/runs/versions (workflow-store.js:26,
  86,195-208); `create` stamps it (line 357); runs/versions inherit from parent
  (lines 525-531); `get/getBySlug/list` accept a `tenantId` scope (lines 401-430).
  This layer provides the column + opt-in scoping (defense-in-depth on top of the
  per-user scoping that already gives transitive tenant isolation); it does NOT
  itself throw on a missing tenant. This is per design.

## 4. Verifier's OWN adversarial attacks (independent throwaway scripts)
Booted the spine in an isolated temp dir, created platform admin
`verifier-ops@atlas.test`, two tenants of my choosing — `wonka` (admin@wonka.test)
and `stark` (admin@stark.test). 21/21 security-critical attacks passed:
- wonka admin `/users` sees ONLY [admin@wonka.test], not stark.
- wonka token on platform `GET /tenants` → 403; cannot `POST /tenants` → 403.
- Ingested unique secret `ZEBRA-QUILL-7731-tenantA-only-qnn4dogjk0k` into wonka's
  RAG over HTTP; wonka retrieves it; **stark query returns 0 hits, secret NOT found
  (leak=false)**.
- Store level: wonka and stark RAG sqlite files are DISTINCT paths; stark's file
  does not contain the secret.
- Second independent canary run: ingested `PLAINTEXT-CANARY-9981-onlyInA` into
  tenant alpha; beta's cross-tenant query returned only beta's own doc (clean, no
  canary); beta's sqlite file did not contain the canary; alpha retrieved its own.
  Confirmed VectorStore genuinely retains content (verbatim `BANANA-42` retrieval),
  so the isolation tests are non-vacuous.
- Forged token (stark user id, `tid=wonka`, bogus jti) → 401 (session/user-tenant
  cross-check rejects it).
- `userStore.list()`, `oauthTokenStore.get()`, `rag.forTenant('')` without a
  tenant all THROW.
- Suspended wonka: existing token on `/users` → 403, on `/rag/query` → 403; fresh
  login → 403; stark UNAFFECTED (200).

Verifier's unique secret `ZEBRA-QUILL-7731-tenantA-only-qnn4dogjk0k` did NOT cross
to the other tenant by any path (HTTP query, store query, or raw file bytes).

## 5. Honesty of record
- Commit messages (3432c45, 074b917, f3e73c4, abcd064, 94fb6d2) accurately
  describe what was built.
- The deferral is DISCLOSED, not hidden: commit f3e73c4 body states
  "(FeedbackStore + WorkflowService CRUD threading deferred — not route-wired in
  Atlas yet.)". Confirmed: FeedbackStore has no tenant_id column and is not
  route-wired.
- docs/architecture/multi-tenancy.md describes the as-built two-regime model
  (shared-DB fail-closed scoping for auth/vault/workflows; physical per-tenant
  RAG).

## Minor notes (non-blocking, not gaps in isolation)
- No git tag points at HEAD though instructions referenced "tagged Phase 1";
  phase is tracked via `Phase: 1` trailers.
- Workflow-store tenant scoping is opt-in (does not throw on missing tenant),
  unlike auth/vault/RAG. This matches the design doc and the disclosed deferral;
  transitive isolation still holds via per-user scoping. Worth tightening to
  fail-closed when WorkflowService CRUD is route-wired.
