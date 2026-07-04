# P11 — Connector Capability Matrix (front-to-back)

**Goal:** verify every connector capability can be used at its declared position(s) in a workflow.
**Method:** fired real-config specs through the real engine (`POST /workflows/run`, the same path the
UI "Run test" uses) on a **freshly restarted** server, paced to avoid rate limits. Catalog pulled
from `GET /capabilities` (67 capabilities). Tenant `agntic` / charles@agntic.co.
**Date:** 2026-07-04.

> **Headline correction:** earlier findings **UX-R11 ("all Slack unwired")** and **UX-R12 ("several
> Google writes unwired")** were **FALSE** — they tested capability IDs that don't exist (raw Slack/
> Google API method names, e.g. `post_message`, `sheets_update`, mis-grepped from the catalog file).
> With the **correct** catalog IDs (`slack`, `slack_history`, `docs_create`, …) almost everything runs.
> Of 67 capabilities, **57 are `ready=true`**; the 10 `ready=false` are all niche Slack actions.

## Verdict

**Yes — the connectors are broadly usable at their declared positions.** Verified working end-to-end:
Slack (post/read/list), Gmail (search/get/send), Calendar (list/create), Tasks (list/create), Docs
(create/read), **Airtable full CRUD** (list/get/search/create/update/delete), Web (search/fetch),
Atlas inbox (in_app/search_inbox). **One real bug found: `drive_create_folder` fails "no access
token"** while sibling Google writes work. A few paths are position-registered but not event-verified
(triggers) or lacked test fixtures (Sheets — no spreadsheet in the account).

## Step / delivery capabilities — tested

| Capability | Connector | Positions | Runs? | Notes |
|---|---|---|---|---|
| `slack` (post) | slack | step, delivery | ✅ | Posted real msg to #history (`delivered:true`, `ts`). Config key **`target`** (channel). Body comes from piped input → posts `{}` if first node with no upstream. |
| `slack_dm` | slack | step, delivery | ✅ (needs `user`) | Needs `config.user` (ID/email), not `target`. |
| `slack_history` | slack | step | ✅ | `target` = channel; read back messages. |
| `slack_list_channels` | slack | step | ✅ | Returned 8 channels; only **#history** has `is_member:true`. |
| `slack_get_workspace_info` | slack | step | ✅ | Agntic / T0B3RTT3Z5X. |
| `slack_list_users` | slack | step | ✅ | Returned users. |
| `slack_reaction` | slack | step | ⚠️ needs `target`+`timestamp`+`emoji` | Not tested with a real msg ts. |
| gmail_search | google | step | ✅ | Real inbox. |
| gmail_get_message | google | step | ✅ | With real msg id. |
| gmail_send | google | step, delivery | ✅ | Verified across multiple published workflows; strips ```html fences, sets `text/html`, styled shell. |
| calendar_list_events | google | step | ✅ | Empty (no events) but runs. |
| calendar_create_event | google | step, delivery | ✅ | Created real event `dloqgir06fbv6b3a0l5bs35ev8`. |
| tasks_list | google | step | ✅ | Empty but runs. |
| tasks_create | google | step, delivery | ✅ | Created real task. |
| docs_create | google | step, delivery | ✅ | Created real doc `1nXFzFY6…`. |
| docs_read | google | step | ✅ | Round-tripped the created doc. |
| **drive_create_folder** | google | step | ❌ **BUG** | *"google: no access token — connect Google via /connectors/google/authorize"* — yet `docs_create`/`calendar_create` (same grant) worked seconds earlier. Scope/token-resolution bug specific to this handler. **→ UX-R22.** |
| drive_list_files | google | step | ⚠️ flaky | Returned files early-session, empty later (R10 throttle-empty). |
| sheets_read / sheets_append | google | step / step,delivery | ❓ untested | `ready=true`, but the account has **no spreadsheet** to test against — needs a fixture. |
| gmail_mark_read | google | step | ❓ untested | Needs a msg id; `ready=true`. |
| airtable_list_records | airtable | step | ✅ | |
| airtable_search_records | airtable | step | ✅ | |
| airtable_get_record | airtable | step | ✅ | Via real record id. |
| airtable_create_record | airtable | step, delivery | ✅ | Created a test record. |
| airtable_update_record | airtable | step, delivery | ✅ | PATCH reached Airtable; only "failed" writing an invalid select-option value ("Qualified" not an existing Status option — data validation, not wiring). |
| airtable_delete_record | airtable | step | ✅ | Deleted the test record (self-clean). |
| web_search | web | step | ✅ | Native Anthropic web_search. |
| web_fetch | web | step | ✅ | Readability extract. |
| in_app / inbox_deliver | atlas | step,delivery / delivery | ✅ | `delivered:true` to Atlas Inbox (body from piped input → `{}` if none). |
| search_inbox | atlas | step | ✅ | Runs (empty results). |
| filesystem_read / filesystem_list | atlas | step | ❓ untested | Tenant-sandboxed to approved folders; none set up in this tenant. |

## Trigger capabilities — registered, event-firing UNVERIFIED

All four show `ready=true` in the catalog (registered), but **actually firing them was not tested** —
that requires generating a real external event + verifying the workflow fires (webhook/poll infra).
**These gate the highest-value "when X happens, do Y" workflows and the Discovery panel — verify next.**

| Trigger | Connector | Mechanism | Fires? |
|---|---|---|---|
| `schedule` | core | scheduler cron tick | ✅ **verified** (Q25/Q26 fixes) |
| `gmail_new_message` (`type:'email'`) | google | **poll** (60s scheduler tick) | ✅ **VERIFIED FIRING (session-6)** — published an email-trigger workflow, sent a matching email, the poll detected it (`gmail.poll.ok found:1`) and the workflow **ran successfully** (`run 12936620 success`). Works on localhost (no external reachability needed). |
| `airtable_record_changed` | airtable | **webhook** (per-base) | ❌ **BROKEN — never fires.** The per-base webhook is registered via `POST /connectors/airtable/webhooks`, which **no code ever calls** (not the UI publish path, not the backend — only referenced in the README). Publishing an airtable-trigger workflow creates an "active" flow with **no webhook subscription** → it can never fire. Separately, the notification URL is `OAUTH_REDIRECT_BASE ?? localhost` so it also needs a public HTTPS host to receive. **→ UX-R23.** |
| `slack_message` / `slack_mention` | slack | **webhook** (app-level Events API) | ⚠️ **unverified.** Dispatch is wired (`/connectors/slack/events` → `dispatchSlackEvent`), and it's an app-level subscription (no per-workflow registration, so not orphaned like Airtable). Requires `SLACK_SIGNING_SECRET` + a public events URL; can't receive on localhost and needs a valid Slack signature to simulate — not fired this pass. |

**Trigger verdict:** schedule ✅ and Gmail ✅ work (poll-based). Airtable ❌ is broken (orphaned webhook
registration — never fires even in prod). Slack ⚠️ is plausibly wired but unverified (webhook, needs
public host). **The valuable "when X happens" workflows only reliably work for Gmail today.**

## `ready=false` capabilities (catalog-declared unavailable — expected, all niche Slack)

`slack_reminder`, `slack_search`, `slack_send_as_user`, `slack_dm_as_user`, `slack_list_reminders`,
`slack_search_files`, `slack_set_status`, `slack_set_dnd`, `slack_star_message`, `slack_list_stars`.
These correctly report unavailable (scope/impl not present) — not a bug, but they should stay out of
converger suggestions.

## Corrections to prior findings

- **UX-R11 — RETRACTED (false):** Slack fully works (tested wrong IDs before).
- **UX-R12 — RETRACTED (largely false):** real Google writes (`docs_create`, `calendar_create_event`,
  `tasks_create`, `gmail_send`) run; the IDs in the original finding don't exist. The one real Google
  write issue is `drive_create_folder` (R22).
- **UX-R10 — deepened:** the throttle-empty stuck state **persists until server restart** (didn't
  self-recover over ~15 min; a restart cleared it). So it's a client-side stuck cache, not just a
  transient 429 — retry/backoff + auto-recovery needed.

## New finding

| ID | Sev | Summary |
|---|---|---|
| UX-R22 | MODERATE | `drive_create_folder` returns "no access token — connect Google via /connectors/google/authorize" while sibling Google writes on the same grant (`docs_create`, `calendar_create_event`) succeed. Token-resolution or missing-Drive-scope bug specific to that handler. |

## Test artifacts created (need manual cleanup — no connector delete for these)

- Google **Calendar** event "ZZ Matrix Test Event (delete me)" — July 10, 2026 (id `dloqgir06fbv6b3a0l5bs35ev8`).
- Google **Task** "ZZ Matrix Test Task (delete me)".
- Google **Doc** "ZZ Matrix Test Doc (delete me)" (`1nXFzFY6Em7iK5fJXeg9S-zGDYUQv9W1i4TTPJTzVHEM`).
- **Slack** #history: two test messages (`{}` and a matrix-test line) — no wired delete.
- Airtable test record — **already auto-deleted** (self-clean). Also the earlier R13 junk record/doc were cleared by these confirmations (Airtable list is clean; the earlier "Untitled" doc may remain — check Drive).
