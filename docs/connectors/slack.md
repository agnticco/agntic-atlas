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
