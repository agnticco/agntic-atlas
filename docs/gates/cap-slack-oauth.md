# Gate: cap-slack-oauth (Slack connector OAuth / per-tenant install) — PASS

- **Date:** 2026-06-09
- **Verified HEAD:** `daba59a169ee6f6a62d93041dd4c0d354f22030c` (branch `feat/p1-slack-oauth`)
- **Based on main:** merge-base `467da67` == `main` HEAD (0 behind / 1 ahead); tree clean.
- **Verifier:** independent (did not write the code).
- **Verdict:** PASS

## Done-when (capability)

A client authorizes the Atlas Slack app via OAuth v2 (no API-console access, no
Marketplace listing); the workspace bot token is exchanged via `oauth.v2.access`
and stored ENCRYPTED in the per-tenant vault under owner key `wsinstall:<tenantId>`
(one row per tenant); an authenticated `/workflows/run` injects only the caller
tenant's token into slack deliver nodes; `/capabilities` is auth-gated + per-tenant
from the install grant; `SLACK_BOT_TOKEN` is only a dev fallback.

## Objective gates (exact commands + exit codes)

- `bash scripts/gates/cap-slack-oauth.sh` -> EXIT 0; "cap-slack-oauth PASS" (11 ok lines).
  Gate is not self-stubbing: delegates to `scripts/checks/slack-oauth.mjs`, boots the
  real spine, requires `SLACK-OAUTH-PASS` sentinel; runs with SLACK_BOT_TOKEN unset.
- Regression (after `rm -rf ./memory`):
  - `bash scripts/gates/p0.sh` -> EXIT 0 (health 200, server.js clean UTF-8/no NUL).
  - `bash scripts/gates/p1.sh` -> EXIT 0 (hand-authored spec posts, ts returned).
  - `bash scripts/gates/cap-slack-map.sh` -> EXIT 0 (scope-gated map + /capabilities).
  - `bash scripts/gates/cap-multitenancy.sh` -> EXIT 0 (auth/vault/workflow/RAG/HTTP isolation).

## Structural review (file:line)

- Encrypted at rest, per-tenant unique owner key: `src/connectors/slack/oauth.js:26`
  (`workspaceOwner = wsinstall:${tenantId}`), `:109` (`cipher.encrypt(botToken)`).
  Store PK is `(user_id, connector_id)` (`src/auth/oauth-token-store.js:35`), so the
  unique per-tenant owner key is what prevents PK collision/clobber across tenants.
- Tenant-required guards THROW: `oauth.js:104` (store), `:118` (get), `:129` (grant),
  `:138` (disconnect); store also fail-closed `oauth-token-store.js:43`.
- State-anchored, single-use callback: state bound to tenant at start `oauth.js:59`;
  `complete()` deletes state before use (`:71`) and rejects unknown/expired (`:72-73`).
  Callback persists `grant.tenantId` from state context, never a caller-supplied tenant
  (`src/api/server.js:381-385`).
- Run injects only caller tenant's token: `server.js:413-418` (keyed on `req.tenant.id`,
  only into `type==='deliver' && channel==='slack' && !config.token`).
- Deliver throws with no token — no silent cross-tenant fallback:
  `src/connectors/slack/index.js:149-150`.
- `/capabilities` auth-gated + per-tenant: `server.js:358-361` (`requireActiveTenant`,
  `resolveForTenant(req.tenant.id)`); scopes from grant preferred over env
  `index.js:104-110`.

## Independent adversarial attack (verifier-authored, /tmp/verifier-attack.mjs)

Stubbed `oauth.v2.access` (token = `xoxb-TOK-<code>`) + `chat.postMessage` (records
bearer). SLACK_BOT_TOKEN unset. Tenants: Northwind (code NWCODE), Soylent (SOYCODE),
Initech (never installs). 24/24 assertions PASS (VERIFIER-ATTACK-PASS). Highlights:

- Distinct tokens minted: codes exchanged `["NWCODE","SOYCODE"]`.
- Northwind run posted `xoxb-TOK-NWCODE` (exactly once); Soylent run posted
  `xoxb-TOK-SOYCODE` (exactly once) — no cross, no env token.
- Forged/unknown state callback -> 400 "unknown or already-used state"; never reached
  oauth.v2.access (no token minted). State replay -> 400 (single-use).
- get/store/disconnect without tenant THROW.
- Uninstalled tenant (Initech) run -> 502, 0 posts (no silent fallback). After
  Northwind disconnect, its run -> 502, 0 posts (no fallback to Soylent's token).
- `/capabilities` without auth -> 401.
- Encryption at rest verified by reading the raw OAuth sqlite: stored blob
  `v1:IEAalqDO3HtayAD1ItYoTg3RVnCGHWTh9_zLW...` contains no `xoxb-` plaintext.
- Disconnect removed only Northwind's row; Soylent's row (`wsinstall:soylent`) remained.

## Honesty of record

Commit `daba59a` body matches code (no overstatement). `docs/connectors/slack.md`
records OAuth onboarding (43-75), no-Marketplace-review + coded-workflows-N/A rationale
(77-85), and SLACK_BOT_TOKEN as dev-fallback (74-75, 145, 149-150).
