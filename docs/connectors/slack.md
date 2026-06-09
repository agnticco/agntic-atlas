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

## Provisioning a workspace (client onboarding)

The connector authenticates with a **bot token** (`Authorization: Bearer …`) and
calls `chat.postMessage`, so onboarding a workspace is: create an app → grant
`chat:write` → install → copy the bot token → invite the bot → grab the channel ID.

1. **Create the app in the target workspace.** api.slack.com/apps → *Create New
   App → From scratch* → name it (e.g. "Atlas") → pick the workspace. For a client,
   create/install in *their* workspace — each install yields its own bot token.
2. **Grant bot scopes.** *OAuth & Permissions → Bot Token Scopes*:
   - `chat:write` — required (post to channels the bot is in).
   - `chat:write.public` — optional; post to *public* channels without inviting first.
   - (For the roadmapped DM feature: `im:write` + `users:read`/`users:read.email`.)
   - Least privilege for clients — don't add scopes the connector doesn't use.
3. **Install → copy the token.** *Install to Workspace* → approve → copy the
   **Bot User OAuth Token** (`xoxb-…`). This is the secret the connector uses as
   `SLACK_BOT_TOKEN`. Treat it like a password.
4. **Invite the bot to each target channel.** In the channel: `/invite @Atlas`.
   Required for private channels (and public ones unless `chat:write.public` is set).
5. **Get the channel target.** `config.target` takes a **channel ID** (recommended,
   e.g. `C0123ABCD`) or `#name`. Find the ID via the channel's details popover, or
   *Copy link* (trailing segment). Prefer the ID — it survives renames.
6. **Wire it in.** Token → `SLACK_BOT_TOKEN` (env, or per-node `config.token`);
   channel → the deliver node's `config.target`. Leave `SLACK_API_URL` unset so it
   hits `https://slack.com/api`.
7. **Test against the real workspace** (token stays in your shell):
   ```
   SLACK_BOT_TOKEN=xoxb-… SLACK_TARGET=C0123ABCD node scripts/checks/slack-post.mjs
   ```
   Expect a real message + a `ts`. Common errors: `not_in_channel` → invite the bot
   (step 4); `missing_scope` → add `chat:write` and reinstall; `channel_not_found` →
   wrong ID or the bot can't see a private channel.

**Validated 2026-06-09** against a live workspace: a real post landed in channel
`C0B3LM5V8PP`, `ts=1781019897.071609`.

### Per-client / multi-tenant note

Today this is **one workspace token at a time via env**, matching the pilot's "no
per-org tenancy" decision (parked until customer #2 — see CLAUDE.md). For multiple
clients, bot tokens should not live in env: store each client's token in the
AES-256-GCM **OAuth vault** (`createAuthSubsystem` → `oauthTokenStore`) via the
manifest-driven connector flow (`connector-manifest.js`), keyed per tenant — no
secrets in env or source. That's the per-user-OAuth roadmap item and lands with
multi-tenancy.

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
| `SLACK_BOT_TOKEN` | — | bot token with `chat:write`. Channel is "ready" only when set. |
| `SLACK_API_URL` | `https://slack.com/api` | API base; override to point at a stub. |
| `SLACK_TARGET` | — | (check only) overrides the spec's target channel for a real post. |

Per-node `config.token` overrides the env token.

## Verify

```
bash scripts/gates/p1.sh
```

Runs `scripts/checks/slack-post.mjs`: boots the spine, mounts the HTTP app, POSTs
`docs/specs/p1-slack-hello.json` to `/workflows/run`. By default it posts to a local
**stub** Slack (asserts the request payload + returned `ts`) — reproducible, no
secrets. For a **real** workspace post: set `SLACK_BOT_TOKEN`, leave `SLACK_API_URL`
unset, and set `SLACK_TARGET` to a channel the bot is in.
