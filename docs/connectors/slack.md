# Connector — Slack (P1)

Built fresh in Phase 1 (the salvage repo had no Slack connector). Proves the spine
end to end: a hand-authored one-step spec runs through the engine and posts to Slack.

## Decision — delivery channel, not MCP (2026-06-09)

The Phase 1 plan frames the chain as "engine ↔ MCP ↔ Slack", but its overriding
goal is to prove the spine **cheaply**. Posting to a channel is fundamentally a
*delivery* action, so Slack is implemented as a **delivery channel**
(`src/connectors/slack/index.js` → `registerSlackChannel`) that calls the Slack Web
API `chat.postMessage` directly — not as a port of the full per-user MCP subprocess
runtime. The MCP runtime stays deferred and is first exercised in **P2** via the
existing `google` connector (Gmail). If/when Slack needs richer tool access (read,
search, reactions), it can be re-homed on MCP without changing the spec shape.

## Planned capability (beyond P1)

P1 ships **post-to-channel** only — the minimum to prove the spine. The full build
needs more, tracked here so the converger's capability schema can grow to match:

- **Direct messages to users** — DM a user by Slack user ID / email (`chat.postMessage`
  to a user, or `conversations.open` then post). Likely a second action
  (`post_dm`) on the connector, or a `target` that accepts `@user`.
- Threaded replies (`thread_ts`), rich blocks/attachments, file uploads.
- Read/search/reactions — the point at which re-homing on the MCP runtime makes sense.
- Per-user OAuth (vs a single workspace bot token) once multi-user lands.

These are not built yet; each becomes a new `action` in `slackCapability` +
`configSchema` field, surfaced via `/capabilities` so the converger can target it.

## How it works

- `registerSlackChannel(channelRegistry)` adds a channel with id `slack`.
- A `deliver` node with `config.channel = "slack"` routes the step's content to it.
  Node config: `{ channel: "slack", target: "<#name | Cxxxx>", body?: "<text>" }`
  (`body` optional — omit to deliver the previous step's output).
- The handler POSTs `{ channel: target, text }` to `${SLACK_API_URL}/chat.postMessage`
  with `Authorization: Bearer ${SLACK_BOT_TOKEN}` and returns `{ delivered, ts, slackChannel }`.
- The capability schema is visible via `GET /capabilities` and the registry's
  `describeForPrompt()` — this is the contract the P3 converger will target.

## Onboarding a client — OAuth (the client authorizes our app)

Clients **no longer give us API-console access or hand us a token.** We run **one**
Atlas Slack app; each client authorizes it ("Add to Slack"), and we store *their*
workspace bot token encrypted in *their* tenant's vault. **No Slack Marketplace
listing/review is required** — this is standard public OAuth distribution (see
docs/architecture/multi-tenancy.md and the research note below).

### One-time, by us (the operator)
1. Create one Slack app (api.slack.com/apps → *From scratch*).
2. *OAuth & Permissions* → add **Bot Token Scopes** (e.g. `chat:write`,
   `chat:write.public`; DM scopes later). Add the **Redirect URL** =
   `https://<atlas-host>/connectors/slack/callback`.
3. *Manage Distribution* → complete the checklist → **Activate Public Distribution**
   (self-serve, no review). This yields the "Add to Slack" install link.
4. Configure the deployment: `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`,
   `SLACK_REDIRECT_URI`, `SLACK_OAUTH_SCOPES` (default `chat:write`).

### Per client (self-serve OAuth)
1. A tenant admin hits **`GET /connectors/slack/authorize`** → returns the
   authorize URL ("Add to Slack"); the operator/UI sends the client there.
2. The client approves in their workspace; Slack redirects to
   **`GET /connectors/slack/callback?code&state`**. We exchange the code via
   `oauth.v2.access` and store the workspace bot token encrypted in **that tenant's**
   vault (one row per tenant, key `wsinstall:<tenantId>`). Granted scopes are stored
   on the row (they drive the capability map).
3. **`GET /connectors/slack/status`** → `{connected, scopes, account}`;
   **`DELETE /connectors/slack`** disconnects.

Once connected, an **authenticated** `POST /workflows/run` injects that tenant's
stored token into `slack` deliver nodes automatically — the workflow posts as the
tenant's own connected workspace. (`SLACK_BOT_TOKEN` remains a single-workspace
**dev fallback** for local testing only.)

### Why no Marketplace review (verified 2026-06-09)
Slack separates **OAuth distribution** (self-serve "public distribution" — no review)
from **Marketplace listing** (reviewed, optional, only for directory discoverability).
Per-tenant OAuth installs need only the former. The "coded workflows are not eligible
for Marketplace listing" rule applies to Slack *automation-platform* apps
(`workflow.steps:*`/`triggers:*` scopes) — not this connector, which is a plain Web
API app (`chat:write`/`chat.postMessage`). Caveat: some Enterprise Grid orgs require
admin approval for non-Marketplace apps. Sources: api.slack.com/start/distributing/public,
docs.slack.dev/slack-marketplace/…, api.slack.com/automation/faq.

**Earlier dev-token validation (2026-06-09):** a real post landed in channel
`C0B3LM5V8PP`, `ts=1781019897.071609` (via the `SLACK_BOT_TOKEN` dev path).

## Capability map (what the AI may use)

The AI/converger needs to know which Slack functions it can actually use — and that
varies by client (different bot tokens grant different scopes). That map lives in
**`src/connectors/slack/capabilities.json`** — a plain, hand-editable list of actions:

```json
{ "id": "post_message", "label": "...", "requiredScopes": ["chat:write"],
  "config": [ ... ], "returns": ["ts","slackChannel"], "implemented": true }
```

**Availability is resolved per client.** An action is `available` to the AI iff:
`implemented === true` **AND** the client's bot token grants every `requiredScope`.

- **Per-client scopes are auto-detected** from the token — `detectGrantedScopes()`
  calls Slack `auth.test` and reads the granted scopes off the `x-oauth-scopes`
  response header. No per-client config to maintain; it never drifts from what Slack
  actually granted. (Re-install with new scopes → `provider.refresh()`.)
- **`implemented` gates honesty.** Today only `post_message` has a handler; the rest
  (`post_dm`, `reply_in_thread`, `add_reaction`, `upload_file`) are in the map as
  defined-but-unavailable so you see the full menu, but the AI won't propose them
  until they're wired.

**Read it:** `GET /capabilities` →
`{ channels: [...], connectors: { slack: { grantedScopes: [...], actions: [{ ...action, available, unavailableReason }] } } }`.
`describeSlackForPrompt()` renders the same as an AI-readable summary.

**Add a capability** (e.g. enable DMs): add/locate its entry in `capabilities.json`,
implement its handler in `index.js`, set `implemented: true`. Clients whose token
carries the `requiredScopes` get it automatically; others see it as unavailable with
the missing scope named.

**Restrict a client:** nothing to edit — grant their bot token fewer scopes and the
map narrows itself. (A manual per-client deny-override can be layered later if a
client needs a capability disabled despite having the scope.)

## Run it ("click run")

No UI yet (greenfield, P4/P5). The "run" path is `POST /workflows/run { spec }`:

```
curl -sX POST localhost:3000/workflows/run -H 'content-type: application/json' \
  -d "{\"spec\": $(cat docs/specs/p1-slack-hello.json)}"
```

Returns `{ runId, completed, deliveries: [{ delivered, ts, target, … }], … }`.

## Config

| env | default | meaning |
|---|---|---|
| `SLACK_CLIENT_ID` | — | Atlas Slack app client id (OAuth). |
| `SLACK_CLIENT_SECRET` | — | Atlas Slack app client secret (OAuth). |
| `SLACK_REDIRECT_URI` | — | OAuth callback, e.g. `https://<host>/connectors/slack/callback`. |
| `SLACK_OAUTH_SCOPES` | `chat:write` | bot scopes requested at install (comma/space list). |
| `SLACK_BOT_TOKEN` | — | **dev fallback only** — a single-workspace bot token for local testing without OAuth. |
| `SLACK_API_URL` | `https://slack.com/api` | API base (`oauth.v2.access`, `chat.postMessage`, `auth.test`); override to a stub. |
| `SLACK_TARGET` | — | (check only) overrides the spec's target channel for a real post. |

Token precedence at delivery: per-node `config.token` → the tenant's stored OAuth
token (injected by the authenticated run path) → `SLACK_BOT_TOKEN` (dev).

## Verify

```
bash scripts/gates/cap-slack-oauth.sh   # OAuth install -> per-tenant token -> post (stubbed Slack)
bash scripts/gates/cap-slack-map.sh     # scope-gated capability map
bash scripts/gates/p1.sh                # dev-token "click run" posts to Slack
```

`cap-slack-oauth.sh` runs `scripts/checks/slack-oauth.mjs`: two tenants each install
via a stubbed `oauth.v2.access`, get their own isolated token, and an authenticated
run posts with the tenant's OWN token (no env token, no cross-tenant token). For a
**real** dev post: set `SLACK_BOT_TOKEN`, leave `SLACK_API_URL` unset, set
`SLACK_TARGET`, and run `node scripts/checks/slack-post.mjs`.
