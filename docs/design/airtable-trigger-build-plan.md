# Airtable Record-Changed Trigger — Build Plan / Handoff

**Status:** planned, **not built**. This is the build brief for the agent that wires up
the Airtable `record_changed` trigger lifecycle. It is self-contained — you don't need
the originating conversation.

**Provenance / re-grounding rule:** the `file:line` references below come from a read on
2026-07-08. They are **non-authoritative provenance** — the invariant + the named
function is the contract. Re-ground each reference against current code before editing; if
a line has drifted, trust the code and the described behavior, not the number.

**Scaling verdict (why this build is worth doing):** it *does* scale for multi-tenant.
Each tenant's webhooks are created with **that tenant's own OAuth token**, so every
Airtable limit (webhooks-per-base, rate limits) is **per-tenant, not global to Atlas** —
no shared ceiling a busy tenant can exhaust for everyone. Ingress is a single URL routed
statelessly by `webhookId`. The work is entirely **webhook lifecycle wiring**, not a
from-scratch build.

---

## 1. Context — it's wiring, not a build

The trigger doesn't fire because **the webhook is never created when a workflow is
published** (the "r23" blocker). Everything else is built.

**What already EXISTS (do not rebuild):**
- Airtable webhook API calls — `createAirtableWebhook` (`src/connectors/airtable/index.js:157`),
  `deleteAirtableWebhook` (`:174`), `refreshAirtableWebhook` (`:178`),
  `fetchWebhookPayloads` (`:182` — already takes a `cursor` and returns
  `{ payloads, cursor, mightHaveMore }`).
- Routing store (JSON-backed, rebuilt in memory) — `initWebhookStore` (`:61`),
  `registerWebhookRoute` (`:78`), `unregisterWebhookRoute` (`:83`), `lookupWebhook` (`:88`),
  `allWebhooks` (`:92`). File: `AIRTABLE_WEBHOOKS_FILE` env or `./memory/airtable-webhooks.json`.
- Trigger capability with a config schema that captures **`baseId` (required)** and tableId
  — `src/connectors/airtable/index.js:292`.
- **The entire dispatch path** — `POST /connectors/airtable/events` (`src/api/server.js:1894`)
  → `dispatchAirtableEvent` (`server.js:409`): HMAC-verified, looks up the route → tenant,
  fetches payloads, resolves matching workflows by **tenant + base + trigger**
  (`server.js:433-436`), and executes them. This is correct and complete.
- A manual create endpoint `POST /connectors/airtable/webhooks` (`server.js:1877`) that
  creates a webhook + registers the route — **but nothing calls it from the publish path.**
- Disconnect cleanup — `DELETE /connectors/airtable` (`server.js:~1861`) deletes registered
  webhooks. ⚠ Verify it is **tenant-scoped** (only deletes the disconnecting tenant's
  webhooks, not all tenants' — the loop iterates `allWebhooks()`; confirm it filters by
  `entry.tenantId === req.tenant.id`).

**What's MISSING (this build):** create-on-publish, the refresh loop, cleanup on
unpublish/delete, cursor tracking, and a tenant-active gate on event ingress.

---

## 2. Target end-to-end flow

```
publish workflow (airtable_record_changed, config.baseId)
   → reuse-or-create ONE webhook per (tenant, base), ref-count it, register route
Airtable change → ping POST /connectors/airtable/events (base + webhookId only)
   → lookupWebhook → tenant  → fetch payloads (with persisted cursor, drain mightHaveMore)
   → tenant active? → resolve matching workflows → execute
refresh loop keeps webhooks alive (7-day expiry); cleanup removes them on last unpublish
```

---

## 3. Multi-tenant scaling design (the decisions to implement)

| Dimension | Risk at scale | Required design |
|---|---|---|
| Airtable per-base webhook cap | N workflows on one base → N webhooks → hit cap | **One webhook per (tenant, base), ref-counted** across workflows |
| 7-day expiry | webhooks silently die | **Refresh loop** on a timer, spread out, rate-aware |
| Ping has no payload | miss / re-process changes | **Persist a cursor per webhook**; drain while `mightHaveMore` |
| Rate limit (5 req/s per base) | burst on a busy base | Backoff; cursor-drain batches changes into fewer fetches |
| Busy base → many runs | runaway cost | **Reuse existing** per-tenant guards (`TENANT_MAX_CONCURRENT`, daily USD cap) |
| Orphaned webhooks | accumulate → hit cap | Delete on last-ref removed + periodic reconciliation sweep |
| Token revoked / disconnect | dead webhooks | Disconnect already deletes them (make tenant-scoped) |
| Routing store = JSON file | not shared across nodes | Fine single-node; → SQLite for scale-out (see §6) |

---

## 4. Two correctness gaps to close (found during planning)

1. **Event dispatch bypasses tenant suspension.** `dispatchAirtableEvent` (`server.js:409`)
   and `dispatchSlackEvent` (`server.js:376`) filter by *workflow* `status:'active'`, not by
   *tenant* status — so a **suspended/archived tenant's triggers still fire**. The scheduler's
   `registerTenantGate` (added for suspend/archive) does NOT cover webhook ingress. Add a
   `spine.auth.tenantStore.isActive(tenantId)` check to **both** dispatch functions, early,
   right after the tenant is resolved. Mirror the fail-open-on-unknown logic used in the
   scheduler gate (`src/api/server.js`, the `registerTenantGate` registration).
2. **No cursor tracking.** Dispatch calls `fetchWebhookPayloads` without a cursor
   (`server.js:425`). Persist the last cursor per webhook (in the routing store / a sibling
   store) and pass it; loop while `mightHaveMore` to fully drain.

---

## 5. Build phases

| # | Phase | Where | What |
|---|---|---|---|
| A | **Create-on-publish** (the core) | `src/api/builder.js` publish path (`POST /api/builder/workflows` → `workflowService.create`) + a helper in the airtable connector | On publish, if the spec has an `airtable_record_changed` trigger: read `config.baseId`; get the tenant's Airtable token (`getAirtableAccessToken`); **reuse** an existing webhook for that `(tenant, base)` if one is registered, else `createAirtableWebhook` with `notificationUrl = <OAUTH_REDIRECT_BASE>/connectors/airtable/events` (see `server.js:1885`); `registerWebhookRoute({ webhookId, tenantId, baseId, macSecretBase64 })`; **ref-count** which workflows use each webhook (store a set of workflow ids/slugs per webhook). Reconcile where `baseId` lives on the trigger — dispatch reads `t.filter?.baseId` (`server.js:434-436`) while the config schema key is `baseId`; make them consistent. |
| B | **Refresh loop** | `src/workflows/workflow-scheduler.js` (or a small dedicated timer wired in `server.js`) | Periodically iterate `allWebhooks()` and `refreshAirtableWebhook` those nearing the 7-day expiry (store `expirationTime` from create/refresh). Spread calls; respect rate limits. Run on the single scheduler instance only. |
| C | **Cleanup + reconciliation** | workflow delete/unpublish path + a periodic sweep | On unpublish/delete of an airtable-triggered workflow, decrement the ref-count; when it hits zero, `deleteAirtableWebhook` + `unregisterWebhookRoute`. Add a periodic reconciliation: list the tenant's Airtable webhooks vs the routing store and delete orphans. |
| D | **Cursor tracking + backoff** | dispatch + store | Persist per-webhook cursor; drain while `mightHaveMore`; backoff on 429s. |
| E | **Tenant-active gate** | `dispatchAirtableEvent` + `dispatchSlackEvent` | See §4.1. |
| F | **Tests** | `tests/e2e/` + a stub | Stub the Airtable webhook API (create returns a fake `id` + `macSecretBase64`), Slack-stub style (`scripts/checks/stub-slack.mjs`, `slack-actions.mjs`). Cases: publish → webhook created + route registered; second workflow on same base → **reuses** the webhook (no 2nd create); event ping → dispatch runs the workflow; **suspended tenant → does NOT fire**; unpublish last workflow → webhook deleted; refresh advances expiry. No live Airtable base needed. |

---

## 6. Single-node (pilot) vs scale-out (later)

- **Pilot (single node):** the JSON routing store + an in-process refresh timer are fine.
  Nothing in this build blocks the pilot.
- **Horizontal scale (documented boundary — NOT build-now):** move the routing store +
  cursors to **SQLite** (shared across instances), and run the refresh loop on the **single**
  scheduler instance (the `SCHEDULER_ENABLED`-on-one pattern in
  [`../architecture/scaling.md`](../architecture/scaling.md)). Leave a clear comment at the
  routing store marking this migration point.

---

## 7. Acceptance criteria

- Publishing an `airtable_record_changed` workflow creates (or reuses) exactly **one**
  webhook per `(tenant, base)` and it fires end-to-end on a real change.
- A second workflow on the same base reuses the webhook (verify: no duplicate create).
- A **suspended/archived** tenant's Airtable (and Slack) triggers do **not** fire.
- Webhooks survive past 7 days (refresh loop).
- Unpublishing the last workflow on a base deletes its webhook; no orphans after a
  reconciliation pass.
- Cross-tenant isolation intact (a tenant's event never runs another tenant's workflow —
  already enforced by route→tenant lookup; keep it).
- Stubbed E2E suite covers create/reuse/dispatch/suspend/cleanup/refresh.

---

## 8. Non-goals / notes

- Do NOT rebuild the Airtable API calls, the routing store, or the dispatch path — they
  exist and are correct.
- Estimate: **~1.5 days** for A–F (production-correct, multi-tenant-safe). The scale-out
  storage migration (§6) is deferred.
- Related: the request-a-connector demand counter + [[mcp-connector-strategy-post-pilot]]
  (post-pilot, MCP servers may replace hand-built connectors — but Airtable's trigger is
  worth finishing natively now since the hard parts are already built).
- Delete this doc once the build lands (it's a temp handoff).
