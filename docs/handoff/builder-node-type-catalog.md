# Node-type catalog — everything the converger can build

Companion to `builder-cot-lanes-design-brief.md`. This is the complete set of node types the
**converger emits**, so the design agent can design a node card for each. Source of truth: the
converger's own system prompt, `src/converger/prompts.js:202` ("AVAILABLE NODE TYPES — only
these — every one is runnable by the engine today"), cross-checked against the engine registry
`src/workflows/node-types/index.js`.

**Distinct card designs needed: 9 node types.** Three of them have visible sub-variants that
should probably each get a treatment (`llm` has 5 modes; `trigger` has 3 flavors). Two of them
(`connector-action`, `deliver`) are ONE adaptive card each, parameterized by a large capability
catalog — do NOT design one card per capability.

---

## The 9 node types

| # | type | plain-language label (de-jargoned) | what the card shows | design notes |
|---|---|---|---|---|
| 1 | **trigger** | "When…" | what starts the workflow | 3 flavors — see below. Always exactly one, always first, runs automatically (no approve buttons). |
| 2 | **llm** | varies by mode | an AI step on the previous output | 5 modes — see below. This is the workhorse; most workflows are mostly llm nodes. |
| 3 | **assemble** | "Combine" | stitches several upstream steps into one document | Deterministic, no AI (free/exact). Shows the sections it's stitching. |
| 4 | **connector-action** | verb varies ("Look up…", "Read…", "Create…") | calls a connector capability mid-flow | ONE adaptive card, parameterized by the capability catalog (below). Label/verb comes from the action. |
| 5 | **decision** | "Decide" | a decision TABLE (2+ inputs / numeric thresholds) | Already has a dedicated review UI (`decision_review`) — a grid of conditions → outcomes. Distinct, table-shaped. |
| 6 | **branch** | "Route" / "If…" | routes down exactly ONE path by a closed value | A control node — the fork. Its cases become the sub-rails in the flow. |
| 7 | **foreach** | "For each…" | runs the same sub-steps once per item in a list | CONTAINS sub-nodes (other node types nested inside). The card needs to hold a mini-flow. |
| 8 | **human** | "Ask a person" / "Approval" | pauses and asks a person to approve/reject | A control node. Shows the question + preview + channels. Must be followed by a `branch` (the gate); design them as a pair. |
| 9 | **deliver** | "Send to…" | sends the final result to a destination | ONE adaptive card, parameterized by channel (below). Always terminal. Fan-out: one deliver node PER destination. |

---

## Sub-variants that likely each want a treatment

### `llm` — 5 modes (each renders as a different kind of step)
The UI already renders these as distinct cards (`effNodeType()` maps llm+mode → a label).
| mode | plain label | does |
|---|---|---|
| `summarize` | "Summarize" | condense the input |
| `extract` | "Pull details" | pull structured fields out as JSON |
| `rewrite` | "Rewrite" | restate in another shape/voice/format |
| `classify` | "Sort" | sort into exactly ONE of a closed list of categories (drives a branch) |
| `freeform` | "AI step" | your own prompt, when no mode fits |

### `trigger` — 3 flavors
| flavor | plain label | example |
|---|---|---|
| `email` | "When an email arrives" | new Gmail matching a filter |
| `schedule` | "On a schedule" | daily / weekly / hourly / every-N-minutes (cron) |
| `event` | "When <X> happens" | connector event: Slack message, Slack @mention, Airtable record changed |

---

## The capability catalog (parameterizes `connector-action` and `deliver`)

`connector-action` and `deliver` do NOT need per-capability designs — each is one card whose
label/params adapt to the selected capability. This list is so the design agent understands the
RANGE the single card must gracefully hold (short labels, 0–4 params, read vs write). Positions:
`step` = mid-flow read/do; `delivery` = can be a final destination; `trigger` = starts a flow.

- **Slack** (~35): `slack_send`/`slack_dm` (delivery), `slack_reply`, reactions, `slack_create_channel`,
  `slack_invite`, `slack_topic`, `slack_pin`, `slack_reminder`, `slack_lookup_user`, `slack_search`,
  `slack_history`, `slack_list_channels`/`_users`, `slack_join`/`leave_channel`, `slack_set_status`,
  `slack_set_dnd`, `slack_file` (upload), `slack_group_dm`, `slack_send_as_user`, … Triggers:
  `slack_message`, `slack_mention`.
- **Google** (~20): Gmail — `gmail_search`, `gmail_get_message`, `gmail_send` (delivery),
  `gmail_mark_read`, `gmail_new_message` (trigger). Calendar — `calendar_list_events`,
  `calendar_create_event` (delivery). Drive — `drive_create_folder`, `drive_list_files`. Sheets —
  `sheets_describe`, `sheets_read`, `sheets_append` (delivery). Docs — `docs_read`, `docs_create`
  (delivery). Tasks — `tasks_list`, `tasks_create` (delivery).
- **Airtable** (9): `airtable_list_bases`, `airtable_describe_base`, `airtable_list_records`,
  `airtable_get_record`, `airtable_search_records`, `airtable_create_record` (delivery),
  `airtable_update_record` (delivery), `airtable_delete_record`, `airtable_record_changed` (trigger).
- **Web** (2, step): `web_search`, `web_fetch`.
- **Filesystem** (2, step): `filesystem_read`, `filesystem_list`.
- **In-app inbox** — the DEFAULT delivery channel ("save to your Atlas inbox"). The commonest
  destination; make sure the deliver card's default state is this, not Slack.

**Deliver channels** (the delivery-capable subset + inbox): `in_app`/inbox, `slack`, `slack_dm`,
`gmail_send`, `airtable_create_record`, `airtable_update_record`, `sheets_append`, `docs_create`,
`calendar_create_event`, `tasks_create`.

---

## NOT emitted by the converger (skip unless you want engine-completeness)

- **`search_web`** — a native web-search node type still registered in the engine
  (`src/workflows/node-types/search-web.js`), but the converger does NOT propose it; it reaches
  web search through a `connector-action` with `web_search`. No card needed.
- **`tool` / `mcp_tool` / `fetch`** — REMOVED. Rejected at publish (`REMOVED_NODE_TYPE`). Do not design.

---

## Two structural notes with design consequences

- **`foreach` contains other nodes.** Its sub-steps are themselves node types (an `llm`, a
  `connector-action`, a `branch`, etc.) nested inside the loop. The foreach card must be able to
  hold a small nested flow of the same node cards — design it as a container.
- **`human` is only a gate WITH a following `branch`.** A `human` node alone doesn't stop the
  next step; the approve/reject decision is enforced by a `branch` reading `{{<id>.decision}}`. So
  a real approval is a `human` → `branch` pair. Design the two to read as one gated moment.
