# P4 — UI follow-ups backlog

A running list of UI items surfaced while verifying the P4 builder UI. The point of
P4 is to confirm the builder UI **works**; items that are bigger than a UI tweak, or
that depend on later-phase backend work, get parked here instead of pulling the
session off-scope.

**How to read this:** each item records what was observed, where in the UI, and the
phase it likely belongs to. "P4" = fix within this phase (a real UI defect). "Later"
= deferred (depends on backend not yet built, or belongs to P5+). Nothing here is a
commitment to do it now — it's a deduped backlog so nothing gets lost.

| # | Date | Area | Observed | Likely phase | Status |
|---|------|------|----------|--------------|--------|
| 1 | 2026-06-18 | Builder sidebar / workflow list | "+ New workflow" overwrites the current workflow instead of creating a new workflow object + adding it to the list. Sidebar list is a hardcoded 1-element array; no persisted multi-workflow list. | P5 inventory | **Deferred → P5** |

---

## Item details

### 1 — "+ New workflow" overwrites instead of creating a new workflow

**Observed:** Clicking "+ New workflow" replaces the existing workflow rather than
spawning a new workflow object and appending it to the sidebar list.

**Root cause (current code):**
- The button (`public/index.html:74`, mini variant `:130`) calls `onReset`, which
  resets the current builder session in place.
- The sidebar list `sidebarWorkflows` (`public/index.html:1131`) is built as a
  **single-element array** holding only the *current* workflow — there is no list of
  saved workflow objects, so nothing can accumulate. The sidebar's own comment
  (`:50`) notes it *should* be sourced from `GET /workflows (list)`.

**Phase split:**
- The **multi-workflow list / inventory** (load `GET /workflows`, show N workflows,
  switch between them, persist drafts) is **P5** — the constitution assigns
  "inventory" to P5's console UI. P4's builder is scoped to building *one* workflow
  by talking.
- A **small P4-scoped** improvement is reasonable now: make "+ New workflow" not
  silently discard an in-progress build (e.g. confirm before reset, or treat it as
  "start over"). Front-end only.

**Decision (2026-06-18):** **Deferred to P5.** Build the switchable, server-backed
workflow list (`GET /workflows`) as part of the P5 console inventory. "+ New workflow"
stays as-is for now (it resets the current build); the confirm-before-discard guard and a
client-side multi-workflow list were both declined in favor of doing it properly in P5.
Note: with draft autosave in place, "+ New" intentionally clears the saved draft (you're
starting fresh) — this is expected, not the refresh-data-loss bug.

---

## Context: known constraints (not follow-ups)

These bound what the UI can be tested against — they're expected, not bugs to file:

- **Connectors aren't executable end-to-end yet.** Slack delivery/actions run; Google
  actions (`gmail_search`, etc.) have handlers but aren't wired into the engine —
  running a Google-step workflow fails with "not available in this build." Full
  execution is **P7/P8**. So the builder UI is verified on flow/interaction, not on a
  live cross-connector run.
- **Workflow execution surface that IS runnable today:** email/schedule/manual/one_time
  triggers → summarize/llm/extract/rewrite → deliver to Slack (channel or DM).
