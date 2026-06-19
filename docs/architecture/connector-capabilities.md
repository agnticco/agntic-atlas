# Connector Capabilities — unified, real-time, position-agnostic

**Status:** Approved direction (2026-06-18). **Increment 2 + parts of 1 & 3 built**
(2026-06-18) — see "Build status" below.
**Why now:** Surfaced while wiring the P4 builder — every connector limitation we hit
(no Slack DM, no mid-workflow actions, no Slack-event triggers) traces back to the same
root cause: a connector's capabilities are **fragmented across three subsystems**, each
tied to a single workflow position. This document defines the target model and a phased
build. It is the connector substrate that **P7 (Google/Airtable write)** and **P8
(web/filesystem)** should sit on.

## The principle

> **Each connector exposes ONE real-time capability catalog. Any capability can occupy any
> position in a workflow — trigger, step, or delivery — subject only to what that capability
> supports and the scopes currently granted.**

A connector is not "a delivery method" or "a trigger." It is a set of capabilities, each of
which declares where it can sit and what it needs.

## Current state (the fragmentation)

Today a connector's capabilities live in three disconnected places, and only one position
is actually wired:

| Position | Lives in | Reality |
|---|---|---|
| **Trigger** | `SourceRegistry` + `WorkflowScheduler` | only `email` (Gmail poll, `workflow-scheduler.js:98`) + `schedule`/`manual`. No connector-event receiver exists (no `/slack/events` route). |
| **Step** (mid-workflow) | a `ToolRegistry` from `../tools/tool-registry.js` | **does not exist** — never built, never passed to `FlowTester` (`flow-tester.js:29,181`). The `tool`/`mcp-tool` nodes throw `Tool registry unavailable` (`node-types/tool.js:22`). Disabled in the converger prompt as a result. |
| **Delivery** | `ChannelRegistry` (`channel-registry.js:75`) | **works.** The full Slack catalog (~30 actions) is registered here (`connectors/slack/index.js`), each with `{id, name, description, configSchema, available, actionOnly}`. The converger now reads it dynamically (`converger/prompts.js` → `deliverySummary`). |

So the same Slack action (e.g. "post a message") is reachable as *delivery* but invisible
as a *step*; "list channels" / "get history" exist as handlers but are unreachable anywhere
because they're `actionOnly` and the step path is dead; and Slack can't *trigger* at all.

Interim P4 patches already in place (to be folded into this model):
- Delivery catalog is read live from `ChannelRegistry`, scope-aware, `actionOnly` filtered
  out (`deliverySummary`).
- `slack_dm` + operator identity wired so "DM me" resolves (`builder.js` capabilities,
  `prompts.js` `operatorSummary`).
- `tool`/`fetch` removed from the converger's proposable nodes until the step path exists.

## Target model

### 1. The Capability descriptor

Every connector capability declares:

```
{
  id:            'slack.post_message',        // namespaced, stable
  connector:     'slack',
  name:          'Post a message',
  description:   'Posts a message to a Slack channel.',
  positions:     ['step', 'delivery'],        // any subset of trigger|step|delivery
  requiredScopes:['chat:write'],              // provider scopes this needs
  configSchema:  [ { key:'target', type:'string', ... } ],
  input:         'text',                       // what it consumes (for step/delivery)
  output:        { shape: '...' },             // what it produces (for step/trigger)
  available:     true,                         // REAL-TIME: computed from granted scopes
  unavailableReason: null,                     // e.g. 'missing scope: channels:read'
}
```

Key properties:
- **`positions`** makes a capability usable anywhere it legitimately can be. "Post message"
  is `step` + `delivery`; "new message" is `trigger`; "list channels" is `step` only.
- **`available` is real-time**, derived from the tenant's *granted* scopes (not the app's
  configured scopes) — so the catalog reflects what will actually work right now, and the
  converger never proposes something that 502s at runtime.

### 2. The CapabilityRegistry

One registry aggregates every connector's catalog and answers position-scoped, tenant-scoped
queries:

```
capabilityRegistry.forTenant(tenantId, { userId }).list({ position })
  → Capability[]  (only `available` ones, scope-aware)
```

It subsumes today's three registries: `ChannelRegistry` (delivery) becomes a *view*
(`position:'delivery'`), the source/scheduler trigger set becomes `position:'trigger'`, and
the never-built `ToolRegistry` is replaced by `position:'step'` over the same handlers.

### 3. Execution: one connector-action node

A single generic node (`connector-action`, replacing the dead `tool` node) executes any
capability at the `step` position by routing to the **existing handler** (the Slack
`actionOnly` channel handlers are already executable). Wire the registry into `FlowTester`
so `services` exposes it. This is mostly unification/routing — the action implementations
already exist.

### 4. Triggers: connector-event receivers

The heaviest piece. A capability with `position:'trigger'` (e.g. `slack.message`) needs a
real event source: a webhook receiver (Slack Events API endpoint with URL verification +
signature check) or a poller. Build per-connector, as needed. Until a connector has a
receiver, its trigger capabilities are listed as `available:false` ("event triggers not yet
wired for this connector").

### 5. Consumers read the same catalog

- **Converger** (`prompts.js`): replace the hand-maintained trigger/node/delivery lists with
  the positioned catalog, so it composes workflows placing connectors anywhere.
- **Engine** (`FlowTester` / scheduler): execute via the registry.
- **UI**: the builder/connections views display real capabilities + availability.

## Phased build

1. **Unify the catalog.** Define the Capability descriptor + `CapabilityRegistry`; have
   connectors declare `positions` + `requiredScopes`; make `ChannelRegistry` a delivery view.
   Real-time `available` from granted scopes. (No behavior change yet.)
2. **Re-enable connector actions as steps.** `connector-action` node → existing handlers;
   wire the registry into `FlowTester`. Re-add the step position to the converger. *Cheap,
   high-value unlock* (handlers already exist).
3. **Converger consumes the positioned catalog.** Remove the hardcoded lists; place
   connectors at any position from the live catalog.
4. **Connector-event triggers.** Per-connector event receivers (Slack Events first).

Increments 1–3 unlock "use any connected connector as a mid-workflow step or delivery, with
a real-time menu." Increment 4 unlocks connector-driven triggers.

## Build status (2026-06-18)

**Done:**
- **`connector-action` node-type** (`src/workflows/node-types/connector-action.js`) — runs
  any connector capability mid-workflow by routing to the existing ChannelRegistry handlers
  (no ToolRegistry needed; `deliver` already proved the routing). Threads the result
  downstream. Registered in the node-type index.
- **Catalog classification fixed** — `ChannelRegistry.getAll()` now exposes `actionOnly`, so
  delivery destinations (content channels) and step actions (`actionOnly`) are
  distinguishable. The converger reads two live, registry-sourced menus:
  `deliverySummary` (delivery) + `stepSummary` (mid-flow actions) in `src/converger/prompts.js`.
- **Converger composes connectors at the right position** — verified: "summarize #general's
  last day and DM me" → `connector-action(slack_history) → summarize → deliver(slack_dm)`;
  a simple "summarize UPS email to #social" stays `summarize → deliver` (no gratuitous
  action). P2/P3/P4 gates green.

- **Per-tenant, scope-aware availability (DONE 2026-06-18):** `builder.js`
  `annotateChannelCatalog` projects the Slack connector's already-correct scope-aware action
  availability (`resolveSlackCapabilities`, which honours both scopes AND user-token needs)
  onto the channel catalog via `channelIdForCapability` (the capability-id ↔ channel-id
  bridge in `connectors/slack/index.js`). Each channel is tagged with `positions`. Fail-open
  when scopes are unknown (don't block building), fail-closed per-action when they're known.
  **Verified A/B:** `slack_history` appears in the converger's plan iff `channels:history` is
  granted; no unavailable action leaks through. P2/P3/P4 green.

- **Increment 4 — connector-event triggers (DONE 2026-06-18, code):** all three positions now
  exist. `POST /connectors/slack/events` (`server.js`): URL-verification challenge +
  HMAC-SHA256 signature check over the raw body (`SLACK_SIGNING_SECRET`, 5-min replay window),
  acks <3s then dispatches async. **Tenant-isolated routing:** the event's `team_id` resolves
  to exactly one tenant via `oauthTokenStore.findTenantByAccount` (the Slack install now stores
  team_id as `account`), and only THAT tenant's active flows with a matching `event`/`slack`/
  `message` trigger run, seeded with the message as `initialContext`. The converger declares a
  `slack.message` trigger capability (`connectorTriggerSummary`) and composes event-triggered
  workflows. **Verified:** challenge echoed, unsigned→401, signed→200; converger builds
  `{type:event,connector:slack,event:message,filter:{channel}} → summarize → deliver`. P2/P3/P4
  green. **Externally gated to fire:** operator must set `SLACK_SIGNING_SECRET` + configure the
  Slack app's Event Subscriptions (Request URL + `message.channels`).
- **Graceful decline (DONE):** the converger now stops and asks rather than building a flow
  that needs an ungranted capability — though the clarification wording is generic, not always
  capability-specific (LLM-dependent; a polish item).

**Still to do:**
- **Increment 1 (full unify):** fold the three registries behind one `CapabilityRegistry` with
  EXPLICIT `positions`/`requiredScopes` per capability (today positions are inferred and scope
  availability is projected). The current approach is correct and scope-aware; this is cleanup.
- **Channel-name event filters:** event dispatch matches the trigger's `filter.channel` against
  the event's channel **ID**; name filters (`#general`) need name→ID resolution to fire.
- **Live read-action / event run** against a real workspace — execution paths proven
  structurally, not yet exercised end-to-end with real Slack events.
- **Google/other connectors:** apply the same scope projection + event receiver (only Slack today).
- **Team-id display:** the Slack install's `account` now stores the team_id (for routing), so the
  Connections page shows the id rather than the workspace name — a cosmetic follow-up.

## Tenant + user isolation (hardened 2026-06-18)

The catalog and tokens are resolved **per tenant, fail-closed** — the operator's dev env
token never leaks across tenants:
- **Scopes:** `scopesForTenant` returns ONLY the tenant's own OAuth grant scopes. No grant ⇒
  no Slack capabilities (empty), never the env token's scopes. The env `SLACK_BOT_TOKEN`
  stands in only when there's **no tenant** (headless tools/gates) or for one explicitly
  designated dev tenant (`SLACK_DEV_TENANT`, unset by default).
- **Delivery/run:** an authenticated tenant with no grant for a connector its workflow uses
  **fails closed** ("<Connector> isn't connected for this workspace"); otherwise every
  connector node gets **that tenant's** token. This is driven by a single **connector
  registry** (`CONNECTOR_INJECTORS` in `server.js`): each entry declares `ownsNode`,
  `resolveToken`, the config `field`, and an optional `devEscape`. `injectTenantTokens` +
  `unconnectedConnector` iterate it, and **every** run path uses them — `/workflows/run`, the
  event dispatch, AND the scheduler tick (`scheduler.registerTokenInjector`). **Adding a
  connector (now or future) is ONE registry entry**, no per-path or per-workflow changes.
  Slack is registered today; Google's actions are REST-only (no workflow nodes) so it needs
  no injector yet, and its catalog is already resolved per tenant+user
  (`createGoogleCapabilityProvider` — fail-closed, no shared token).
- **Disconnect:** the Connections page "Disconnect" button calls `DELETE /connectors/<id>`
  (deletes the tenant's grant) so a connector can be reconnected — e.g. to re-authorize with
  new scopes. Endpoints exist for slack + google.
- **User scopes:** xoxp "as-user" actions stay unavailable for real tenants (a shared env
  user token would act as one person for everyone — a user-isolation leak). They're enabled
  only for the dev tenant / headless until per-user OAuth exists.
- **OAuth request scopes** (`resolveRequestScopes`) are app-level (derived from the reference
  token) and the install is bound to the requesting tenant+user via signed `state` — no
  tenant/user data in that path.

**(Closed 2026-06-18)** The scheduler tick now applies the same injector — scheduled and
email-triggered Slack steps post as the owning tenant, not the operator's env token.

## Non-goals / constraints

- Multi-tenant isolation holds: the catalog is always resolved per tenant; availability uses
  that tenant's granted scopes (never the app's max scopes). See
  [`multi-tenancy.md`](multi-tenancy.md).
- Don't break the frozen canonical UPS→Slack spec or the P2/P3 gates — delivery shape and
  the email-trigger path must keep working through every increment.
- A capability the engine can't run must be `available:false`, never silently proposable.
