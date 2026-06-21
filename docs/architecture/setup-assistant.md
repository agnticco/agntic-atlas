# Setup Assistant — Design

## Problem

Some workflows have **one-time preconditions** that must be true before the
recurring trigger can fire correctly — but that are extraneous to the workflow
itself. Examples:

- An Airtable workflow needs a "Leads" table that doesn't exist yet
- A Slack workflow needs a private channel to be created and the bot invited
- A Gmail workflow needs a label or filter configured in the account
- A webhook workflow needs the receiving endpoint registered

These are **setup actions**: they run once, produce a permanent side effect, and
are never part of the recurring execution loop. Currently nothing in Atlas handles
them — the converger builds the spec, the executor runs it, and if a precondition
is missing the run fails with a `NOT_FOUND` or similar error at step 1.

## The Pattern

Setup actions share a property: they are the same *kind* of action the execution
agent can perform (connector API calls), but they exist outside the trigger/step/
deliver loop. They belong to workflow *initialization*, not workflow *execution*.

The mental model: every workflow has two phases —

| Phase | Who runs it | When | How |
|---|---|---|---|
| **Setup** | Operator + assistant | Once, at build time | Conversational, on-demand |
| **Execution** | Engine | Every trigger | Automated, spec-driven |

## Proposed Solution: Workflow Setup Assistant

A context-aware chat widget attached to each workflow's detail view in the
console. It has:

- **Full workflow context** — the live spec, connector IDs, table/channel names
  the spec references
- **Full connector execution access** — same capability handlers the DAG executor
  calls, with the tenant's tokens already injected
- **Conversational interface** — the operator describes what they need in plain
  language; the assistant executes against real connectors
- **Permanent side effects** — actions taken here persist in the connected
  services (a created Airtable table stays created), unlike test runs which are
  transient

## What It Does

The assistant inspects the workflow spec and can:

1. **Identify missing preconditions** — "This workflow writes to an Airtable table
   called 'Leads' but I don't see that table in your base. Want me to create it?"
2. **Execute setup actions** on request — create tables, invite the bot to a
   channel, verify a Gmail filter, register a webhook endpoint
3. **Answer setup questions** — "Which Airtable base should this workflow use?"
   and update the spec when the answer changes the config
4. **Run a preflight check** — walk through every node's preconditions and report
   green/red before the workflow is activated

## Architecture

### New endpoint: `POST /api/builder/setup-action`

```
Body:    { workflowId, message, history[] }
Returns: { reply, actions: [{ capability, config, result }] }
```

The handler:
1. Loads the workflow spec (`workflowService.get`)
2. Resolves connector tokens for the tenant (same as the run path)
3. Builds a system prompt with: full spec, connector schema (Airtable bases/
   tables, Slack channels, etc.), and available capability handlers
4. Invokes the LLM with the operator's message
5. When the model decides to execute a capability, calls the handler directly
   (same `cap.handle(config)` the DAG executor uses)
6. Returns the reply + a log of what was executed and what it returned

### Capability execution

The same `CapabilityRegistry.getHandler(id)` path used by the executor — no new
connector code. Tokens are injected via `injectTenantTokens` before any call.
The only difference from a workflow run: there is no DAG, no run log, no
`{{prev}}` threading — each action is a direct capability call.

### Preflight check

A special message trigger: when the workflow is first published (or when the
operator clicks "Run preflight"), the assistant automatically:
- For each `connector-action` and `deliver` node: verifies the referenced
  base/table/channel exists and the token has the required scope
- Reports a simple green/red list
- Offers to fix each red item in-place

### UI placement

Console workflow detail page → new **"Setup"** tab alongside "Runs" and "SOP".

- Always accessible (not just at first publish)
- Shows the assistant chat history for this workflow
- Shows a preflight status badge (green = ready, amber = warnings, red = blocked)
- Badge appears in the workflow inventory list so operators can see setup state
  at a glance

## Distinguishing Setup from Edit

| | Edit flow | Setup assistant |
|---|---|---|
| **Changes the spec** | Yes — rewrites JSON | Only if config needs updating |
| **Executes connectors** | No | Yes |
| **Persists in connected services** | No | Yes |
| **Access point** | Console edit button | Console Setup tab |
| **Triggered by** | Operator intent to change workflow | Missing preconditions or operator request |

## Implementation Notes

- The setup assistant's LLM calls are **tagged as `type: setup`** for cost
  tracking in P10.
- Airtable table creation requires `schema.bases:write` scope — not currently
  requested in the OAuth flow. The preflight check should surface this if the
  operator asks to create a table. Add the scope to the OAuth request or explain
  the gap.
- Setup action history is stored per-workflow (a new `setup_log` column or a
  lightweight separate table) so the assistant can remember what it already did.
- The assistant should decline to delete or destructively modify existing data —
  setup actions are additive only. Destructive actions (delete a table, remove a
  channel) require explicit confirmation and are out of scope for the initial build.

## Phase

Targeted for **P9** alongside the workflow profile page. The setup assistant and
the profile page are both "workflow-level intelligence" surfaces that live in the
console workflow detail view — build them together so the tab structure is
designed once.
