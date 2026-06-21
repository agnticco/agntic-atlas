# Future Thoughts

Ideas and directions that came up in context but were deliberately deferred. Not a backlog — a place to capture thinking before it evaporates.

---

## Wait position (mid-flow suspend/resume)

**The idea:** A fourth workflow position alongside trigger / step / delivery. A `wait` node suspends execution mid-run, serializes all results from nodes that already ran, stores state to the DB, and resumes from exactly where it left off when an external signal arrives.

**Why it's valuable:** Enables approval gates, human-in-the-loop checkpoints, and event-driven continuations inside a workflow. Example: summarize an email → wait for user approval → only then send the Slack message.

**The hard part:** The execution engine currently runs a DAG start-to-finish in one pass. Wait breaks that — requires partial execution serialization, a `waiting` run status, a new `run_waitpoints` DB table, and a resume endpoint.

**Recommended first implementation:**
- `wait_for_approval` — suspends, sends a Slack DM or email with a one-time approve/reject URL (`POST /runs/:id/resume?token=...`), resumes with `{ approved: true/false, note }` as the next node's input
- `wait_for_webhook` — suspends until a POST arrives at a generated URL, passes the body forward as next node's input

**Key design decision:** HTTP link first (connector-agnostic, works everywhere), Slack button as a cosmetic improvement later.

**Prerequisite:** Nothing — this can be built independently once P7 is closed.
