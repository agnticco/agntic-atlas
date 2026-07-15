# MCP Capability Adapter — scaling connectors with read/write breadth

**Status:** proposed (candidate P13). **Decided direction, not yet built.**
**Author:** connector-strategy audit, 2026-07-14.
**Supersedes the intent of:** the `mcp-connector-strategy-post-pilot` note ("evaluate
consuming MCP as a generic connector-expansion path after launch"). This is that
evaluation, concluded.

---

## The question this answers

> Does adopting MCP give us a fast way to scale our connectors with **full
> capability**, since MCP is a read *and* write pattern?

**Yes, for ~94% of our capability surface — with two bounded asterisks (no triggers,
coverage is per-server).** The rest of this doc is *where* to put the MCP seam so that
"yes" is real and does not cost us the P12 converger moat.

The one-line decision: **do not make the converger speak MCP or OpenAPI. Add adapters
that project external tool definitions *into* the existing `CapabilityRegistry`.** The
converger, the decision moat, and the SOP keep reading the one catalog they already read.

**Primary breadth engine: OpenAPI-autogen. Fallback: MCP.** (Revised 2026-07-14 after the
head-to-head research — see "Two adapters, one contract".) OpenAPI derives more of our
catalog from *structure* (HTTP verb → effect, response schema → locators, `enum` → closed
domains) and reuses our existing OAuth vault verbatim; MCP's equivalent metadata is optional
author-supplied hints and carries the two-hop auth problem. MCP is reserved for
OpenAPI-poor, AI-native services (Linear is GraphQL-only; Notion ships no first-class spec).

> **⚠️ Correction to an earlier draft of this doc:** the claim "the converger never learns
> [about the new source] / needs zero changes" is **~90% true, not 100%.** A code audit
> (2026-07-14) found the validator, gap-scorer, and the propose/analyze/ratify loop are
> genuinely catalog-generic, but P12-F hardwired three connector-specific seams that a new
> capability source hits. Those must be generalized **first** (increment P13-0 below) — they
> are pre-existing F-era debt, not new debt, and closing them also fixes the already-broken
> native Sheets path. See "The converger seams that must be generalized first".

---

## Why MCP is the right breadth play, quantified

MCP tools are genuinely read **and** write — an MCP server exposes `create_record`,
`send_message`, `update_row`, `delete` alongside the reads. That outbound axis is
almost all of what a connector does for us.

Measured against our own catalog (66 registered capabilities today):

| Position | Count | MCP covers it? |
|---|---:|---|
| step / delivery (outbound read + write) | ~62 | ✅ this is what MCP tools are |
| trigger (Slack ×2, Gmail ×1, Airtable ×1) | ~4 | ❌ not in the protocol |

> **~94% of our capability *pattern* is outbound read/write — exactly MCP's shape.
> ~6% is triggers — which stay hand-built regardless.**

So MCP scales the **number** of read/write connectors fast. That is the prize, and it
is real.

### The two asterisks on "full capability"

1. **Per connector, "full" caps at step + delivery — never trigger.** An
   MCP-sourced connector can *act on* Notion/Linear/HubSpot (read and write) but
   cannot *fire a workflow when something changes there*. Event-driven workflows off
   an MCP connector need a hand-built trigger or a scheduled poll.
2. **Coverage is bounded by what each server exposes, not the underlying API.** An
   MCP server author picks which slice of the API to surface. "Add the server → full
   coverage" is really "get the curated subset the author chose." Fine for the long
   tail's common 80%; gaps on a service you want deep are still yours to fill.

**Fast to add *many* read/write connectors → yes. Fast to make any *one* connector
complete + event-driven → no.** That is exactly why the core stays native and the
long tail goes MCP (see Scope).

---

## Why the seam is the CapabilityRegistry, not the converger

An MCP tool definition declares only: `name`, `description`, `inputSchema`, and
(optional, often absent) `outputSchema`.

The converger/engine needs a **superset** of that — and the superset is precisely the
P12 moat. If the converger consumed MCP tools directly, it would ingest MCP's thinner
metadata into the completeness proof and `complete ⇒ publishable` would stop holding.

| The converger/engine depends on… | MCP tool gives… | Adapter supplies the gap via… |
|---|---|---|
| `configSchema` (typed params, required vs optional) → `UNKNOWN_CONFIG_KEY`, required-param check, dropdown UI | ✅ `inputSchema` maps cleanly | direct JSON-Schema → `configSchema` projection |
| **position** (trigger/step/delivery) | ❌ none | annotation (always `['step','delivery']` for a write tool; `['step']` for a read tool; never `trigger`) |
| **`nodeEffect` / `isWriteNode`** (does it write?) → outcome assertions, `WEAK_APPROVAL_FOR_WRITE`, `MISSING_DELIVER`, idempotency | ❌ no effect semantics | annotation (`effect: 'read' \| 'write'`) |
| **output locator keys** → `normalizeDelivery`, runtime oracle (`record_exists`/`message_sent`) | ❌ `outputSchema` usually absent | annotation (`locator: ['id']` etc.) |
| **closed output domain** → `LLM_INPUT_NOT_ENUM` / decision-routing moat | ❌ not declared | **default deny**: MCP capabilities are barred as a `branch`/`decision` routing source unless an annotation declares a closed `values[]` |
| **per-channel output format** (mrkdwn/html/plain) | ❌ our problem | annotation (`outputFormat`), same field the native caps already carry |

The moat is preserved **by construction**: an externally-sourced capability enters the
same `CapabilityRegistry.register(...)` shape as a native one, so every existing engine
guard fires on it by node type. Tag a write tool `effect:'write'` and it automatically
gets idempotency + the approval-gate treatment; leave its output domain undeclared and
the decision moat refuses to route on it. The validator, gap-scorer, and elicitation
loop need **no** changes — *provided* the three F-era seams below are generalized first.

---

## Two adapters, one contract

Both an OpenAPI operation and an MCP tool def project into the **same** internal
capability shape. Write **one** capability contract and **two** thin adapters into it:

| | **OpenAPI adapter (primary)** | **MCP adapter (fallback)** |
|---|---|---|
| Source | a service's OpenAPI/Swagger spec | a remote (Streamable-HTTP) MCP server |
| `configSchema` | operation params + requestBody schema | tool `inputSchema` |
| **effect** (read/write) | **HTTP verb, deterministic** (GET/HEAD→read; POST/PUT/PATCH/DELETE→write) | `readOnlyHint` if set, else **fail-closed to `write`** + human override |
| **locators** | response schema property names | `outputSchema` if present, else example-call inference |
| **closed domains** | `enum` in request/response schemas | `enum` in `inputSchema` |
| position, output format | manual annotation (neither source declares) | manual annotation |
| auth | tenant token on the `Bearer` header — **reuses the existing vault** | per-tenant OAuth flow to the MCP server (two-hop) or header token where the server accepts one (Linear/GitHub/Stripe/Atlassian/Airtable do) |
| runtime dependency | our own HTTP call — our retry/error/idempotency | third-party MCP server uptime + supply-chain surface |

**When to use which:** OpenAPI for anything with a usable REST spec (the wide funnel,
and where effect/locator/enum come from structure). MCP only when a requested service
ships a good MCP server and **no** usable OpenAPI/GraphQL surface to project — Linear and
Notion are the archetypes. A mandatory human curation pass gates both (filter operations,
set position + output format, confirm effect) — every generator vendor's own guidance is
that raw autogen ships too many low-context tools.

---

## The converger seams that must be generalized first (P13-0)

A 2026-07-14 audit confirmed the validator, `gap-scorer.js`, and the elicitation loop are
catalog-generic. But three P12-F seams are hardwired to the literal string `'airtable'`
and would break or degrade a new capability source. **These are pre-existing debt** — the
already-built `sheets_describe` capability is unwired for the same reason, so native Google
Sheets writes already suffer seam #3 today. Fix these before adding any adapter.

1. **`outcome-oracle.js` `WRITE_VERBS` regex — the dangerous silent one.** It recognizes
   `create_record`/`send`/`post` but not `create_page`-style tokens, so a new write tool is
   **misclassified as a read → silently skips idempotency and the approval gate.** This is
   the effect-scoped-to-the-name failure class the whole phase exists to kill. Effect must
   derive from the adapter's structural signal (HTTP verb / declared `effect`), **not** a
   token regex on the capability id.
2. **`outcome-oracle.js` `CHANNEL_EFFECTS` + no `deliver` fallback.** The `deliver`-node
   effect path reads a hardcoded ~12-id table with no verb-regex fallback (only
   `connector-action` has one), so a new delivery capability's outcome assertion can never
   be satisfied → **`UNSATISFIED_ASSERTION` blocks publish** on a correctly-configured node.
   Give `deliver` the same structural fallback.
3. **`elicitation-graph.js` `destinations` node is Airtable-only by literal string**
   (`usesConnector(n,'airtable')`, hardcoded `airtable_list_bases`/`airtable_describe_base`,
   `rewriteAssertionFields` matching `/airtable/i`). A new write capability gets no
   schema-discovery / click-to-pick-a-destination UX and drops back to "make the user paste
   an id" — violating F's own "never ask for what we can read" rule. Generalize off any
   capability that declares a `*_describe`-style schema-read action; this also finally wires
   `sheets_describe` for native Sheets. (The dead `AIRTABLE_ID_KEYS` constant shows the
   generalization was planned and never finished.) Same for the bespoke Airtable/Slack REST
   pre-fetch in `builder.js` — route it through the generic capability catalog.

---

## The annotation layer

MCP gives us `inputSchema`. We supply the four things it omits. The annotation is
small, per-tool, and lives beside the server registration — this is the "config edit"
that adding a connector should have been all along.

```jsonc
// mcp-servers/<serverId>.jsonc — one file per MCP server
{
  "serverId": "notion",
  "transport": "streamable-http",
  "url": "https://mcp.notion.com/mcp",
  "auth": { "connectorId": "notion", "inject": "bearer" }, // per-tenant token → Authorization header
  "tools": {
    // key = MCP tool name; value = the metadata MCP does not carry.
    // A tool NOT listed here is imported read-only, step-only, un-routable (safe default).
    "create_page":   { "effect": "write", "positions": ["step","delivery"], "locator": ["id","url"], "outputFormat": "plain" },
    "update_page":   { "effect": "write", "positions": ["step"],            "locator": ["id"] },
    "search":        { "effect": "read",  "positions": ["step"] },
    "get_page":      { "effect": "read",  "positions": ["step"] }
  }
}
```

Defaults are **fail-safe**, matching the house rule that a silent fallback is the bug:

- No annotation for a tool → imported as `effect:'read'`, `positions:['step']`, **not**
  routable by a branch/decision. A read-only step is the safe assumption; a wrongly
  un-flagged **write** would skip idempotency + approval, so writes must be declared
  explicitly, never inferred from the tool name.
- No `auth` block → the capability's `isReady()` returns false until credentials exist,
  exactly like a native connector that isn't connected.

---

## Ingest flow

```
mcp-servers/*.jsonc
        │
        ▼
  McpCatalogLoader                          (new — src/connectors/mcp/)
   ├─ connect to server (Streamable HTTP), list tools  → { name, description, inputSchema }
   ├─ for each tool: merge with annotation from the .jsonc
   ├─ project inputSchema → configSchema  (JSON-Schema → the [] shape register() wants)
   └─ registry.register({
         id: `${serverId}_${tool}`,        // stable, namespaced, same convention as native
         connector: serverId,
         positions,                         // from annotation
         configSchema,                      // from inputSchema
         requiredScopes: [],                // MCP handles scope at its own auth layer
         outputFormat,                      // from annotation (default 'plain')
         isReady: () => hasTenantAuth(serverId),
         handle: makeMcpHandle(serverId, tool),   // ← the only new execution path
       })
        │
        ▼
  CapabilityRegistry   ← unchanged; converger / engine / oracle / SOP read this as today
```

`makeMcpHandle(serverId, tool)` is the single new outbound path. Its shape matches the
existing `handle: async ({ config, body, lastOutput, title }) => result` contract
(`capability-registry.js:37`), so the engine invokes an MCP capability exactly like a
native one via `getHandler(id)` — it opens a Streamable-HTTP session to the server,
injects the tenant token (below), calls the tool with `config`, and returns a result
shaped to carry the annotated `locator` keys so `normalizeDelivery` / the runtime
oracle work unchanged.

---

## Multi-tenant OAuth — the two-hop problem, handled with the vault we already have

MCP does **not** remove per-tenant OAuth; it relocates *where the token is stamped*.
The MCP auth spec covers only hop 1 (client → MCP server). Hop 2 (MCP server →
Slack/Google **as this tenant**) is out of scope of the spec and stays our problem.

Concretely, nothing new is invented — the adapter reuses the existing seam:

- Today `injectTenantTokens` (`server.js`, `CONNECTOR_INJECTORS`) stamps a tenant's
  token into a node's **config** before each run.
- For an MCP capability, the same resolved token is instead put on the **transport** —
  the `Authorization: Bearer <tenant-token>` header of the Streamable-HTTP session — by
  `makeMcpHandle`, keyed off the `.jsonc` `auth.connectorId`.

The AES-256-GCM per-tenant vault, the fail-closed "throw on missing tenant" scoping,
and the refresh/rotation logic are **the answer to the two-hop problem**, not something
MCP retires. A self-hosted community MCP server would otherwise force us to rebuild that
vault inside it; injecting on our side keeps the one vault authoritative.

> **Rule:** an MCP capability resolves its tenant credential through the *same*
> `oauthTokenStore` + `token-cipher` path as a native connector. No MCP server —
> vendor-hosted or self-hosted — is ever handed a tenant token it wasn't scoped, and no
> token is passed through from one hop to the next (the spec's `MUST NOT`).

---

## Scope — what goes native, what goes MCP

**Stays native (do not convert):** Slack, Google Workspace, Airtable, web, filesystem.
We already own their handlers, channel-aware output formatting, triggers, and OAuth.
Converting them to MCP is pure cost with no metadata upside, and for Google there is no
official hosted Workspace MCP server to point at anyway (Google's official MCP is Cloud
services only — BigQuery/Maps/GCE — not Gmail/Sheets/Drive).

**Goes MCP (the expansion lane):** everything we have *not* built and will not — the
long tail (Notion, Linear, HubSpot, Jira, Stripe, GitHub, …). Outbound read/write only,
explicitly no triggers. Fed credentials from the existing vault.

**Non-goals:**

- MCP-sourced **triggers** — not in the protocol (Triggers & Events is pre-spec).
  Revisit when that spec lands.
- **stdio / per-tenant subprocesses** — wrong transport for a single multi-tenant Node
  process. Consume **remote Streamable-HTTP** servers only.
- Handing tenant tokens to **third-party MCP aggregators** (Composio/Zapier/Klavis) —
  contradicts fail-closed isolation. Self-host or vendor-hosted-with-our-OAuth only.

---

## Correction: the "salvaged MCP runtime" is NOT in this repo

CLAUDE.md's *Don't touch (salvage)* list describes an "MCP connector runtime —
per-user subprocess isolation, isolation-tested, manifest-driven." **That runtime
exists only in the read-only `agntic-prod` archive and was never migrated to Atlas.**
What is actually here: `src/connectors/connector-manifest.js` (an inert `mcp` data
template, marked inert in its own header at line 20 — "INERT data in Slice 2") and a
dead `registerMcpChannel` wrapper (`src/workflows/channel-handlers.js`) gated on a
`ToolRegistry` class that does not exist in this codebase. The `mcp_tool` node type was
deleted in P12-A (`REMOVED_NODE_TYPE`).

So this adapter is **new construction**, not a flip-on. It deliberately does **not**
resurrect the archived stdio/subprocess pool — that was the wrong transport for
multi-tenant hosting. It builds a fresh Streamable-HTTP client that registers into the
existing catalog. (CLAUDE.md corrected in the same commit as this doc, per the
doc-is-the-memory rule.)

---

## Suggested build increments (P13 shape)

Each ends at a demonstrable gate.

- **P13-0 — generalize the converger seams (prerequisite, do this first).** Fix the three
  F-era hardwirings above: effect from structural signal not a token regex (seam #1), a
  `deliver`-node effect fallback (seam #2), and destination schema-discovery driven by any
  `*_describe` capability not the literal `'airtable'` (seam #3, which also wires native
  `sheets_describe`). Gate — adversarial: register a synthetic write capability
  (`x_create_page`, effect=write) with NO code special-casing it, and confirm it (a) is
  classified as a write and gets idempotency + approval, (b) satisfies a `record_exists`
  assertion as a `deliver` node, (c) offers click-to-pick destination resolution. This gate
  is the proof the catalog is genuinely source-agnostic before any adapter exists.
- **P13-A — the capability contract + OpenAPI adapter (primary).** One internal contract;
  the OpenAPI→capability projector (params→`configSchema`, verb→effect, response→locators,
  `enum`→domains) behind a human curation pass. Gate: a capability autogenerated from a real
  OpenAPI spec (Stripe or GitHub — both ship excellent specs) appears in `/capabilities` and
  `list()` beside native caps with correct effect/positions.
- **P13-B — outbound execution + per-tenant auth (OpenAPI path).** Generated handler makes
  the HTTP call with the tenant token injected on the `Bearer` header via the existing
  vault/`CONNECTOR_INJECTORS`; fail-closed on missing tenant. Gate: a workflow with one
  autogenerated read step + one native `deliver` runs green; two tenants isolated.
- **P13-C — MCP adapter (fallback).** `McpCatalogLoader` + `makeMcpHandle` for a remote
  Streamable-HTTP server; used for an OpenAPI-poor service (Linear or Notion). Token on the
  transport from the vault where the server accepts a header token, else the per-tenant OAuth
  flow. Gate: a Linear/Notion write runs end-to-end for a connected tenant.
- **P13-D — writes + the moat, adversarial.** Re-run the P12 moat suite with BOTH an
  OpenAPI-sourced and an MCP-sourced write capability substituted in: idempotency + approval
  fire, outcome assertions satisfy via locators, and a branch/decision **refuses** to route
  on any capability with no declared closed domain. Gate: the moat holds identically
  regardless of capability source.

**Do not weaken any P12 invariant to land this.** `LLM_INPUT_NOT_ENUM` and the
`complete ⇒ publishable` floor apply to MCP-sourced capabilities exactly as to native
ones — that is the whole reason the seam is the CapabilityRegistry and not the converger.
