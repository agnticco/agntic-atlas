# Product hardening — 2026-07-21

**Read this before touching the builder or the test panel.**

This session started as demo preparation and became product hardening, because
driving the real product for twenty minutes surfaced defects a viewer or a client
would hit too. Ten were fixed and deployed (**v1.6.4 → v1.6.11**); two suspicions
were killed as non-bugs; one blocker is **open and precisely diagnosed** below.

Every fix in here was found by **using the product in a browser**, not by reading
code. None of them had a failing test. That is the pattern worth carrying forward.

---

## 1. ~~THE OPEN BLOCKER~~ — FIXED 2026-07-21, and the diagnosis below was wrong

**The cause was not the example loop.** `_applyTestResult`'s paused branch read
`runDurationMs`, a `const` declared ~40 lines BELOW it in the same function — a
temporal dead zone. So **every** paused run threw `ReferenceError: Cannot access
'runDurationMs' before initialization`, from inside the animation interval, after
that interval had been cleared. Nothing caught it.

That single throw explains **all four** symptoms in §2, not just the hang: the timer
froze at the moment of the throw (U3), and the body kept its pre-run copy and CTA
because no `setState` ever landed (U1, U2).

It also means the claim below that *"the SINGLE-run path already handles this
properly"* was **false** — that path was the broken one. It was never exercised,
because an approval workflow always carries examples.

Fixed by hoisting the declaration to the top of the function, plus a genuine (if
secondary) defect the original diagnosis did find: the example loop carried only the
LAST example's data forward, so a pause on any earlier example was dropped. First
pause now wins. Pinned by `tests/api/test-panel-paused.test.js`, which executes the
real method source and was watched go red against the pre-fix file.

**Still not done — §1.2 below (letting the tester answer Approve/Reject in the
panel).** The panel now tells the truth and stops spinning, but the steps after the
gate remain unexercised by any test, and `testState: "paused"` correctly leaves Go
live locked. So an approval workflow is testable and honest, **not yet publishable
through the panel.** That is the next piece of work.

---

### The original diagnosis, kept for the record

### You cannot publish any workflow containing an approval step

**Reproduced live, 2026-07-21 22:58.** Build a workflow with a `human` step, approve
every step, press **Run test**. Every example run pauses at the approval, the server
returns cleanly, and **the panel hangs on "Testing…" forever.** Go live never
unlocks. There is no timeout, no error, and no way out but a reload.

Server evidence (`memory/logs/atlas-events.log`):

```
4 × run.start
4 × run.paused   nodeId: approval
POST /workflows/run → 200, ~1s each
```

The engine is **correct** — pausing is exactly right. The client is what fails.

**Where it is.** `public/index.html`:

- `~5736` — the SINGLE-run path already handles this properly:
  `if (d.paused) { setState({ testState: "paused", … }) }`
- `~7232` — the copy already exists and is good: *"The test ran up to your approval
  step and stopped there — that's correct: in a real run it waits for your answer
  before doing anything after it. I can't answer it for you here, so the steps after
  the gate aren't covered by this test."*
- `~8267` — the label already exists: `TS === "paused"` → **"Waiting on a person"**
- **The EXAMPLE LOOP does not use any of it.** When every example pauses, nothing
  resolves and the state never leaves `running`.

**The fix, scoped.** Treat a paused example run as a first-class outcome in the
example-loop result handler, not as "still going":

1. Minimum: if every example paused, land in `testState: "paused"` with the existing
   copy. The user learns the truth instead of watching a spinner.
2. Better: let the tester answer **Approve / Reject** in the panel, so the steps
   after the gate are actually covered. Without this, an approval workflow's most
   important half is never exercised by any test — and per `outcome-oracle.js`
   doctrine, an unexercised promise must NOT certify (`not_exercised`, never `kept`).

**Do not** make a paused run count as a pass to unblock publishing. That is the
false-certification failure this codebase keeps re-learning; see §3.

---

## 2. UI bugs observed in the same panel (all live, all reproducible)

Individually cosmetic, collectively corrosive — they make a viewer distrust
everything else on the screen.

| # | Bug | Detail |
|---|-----|--------|
| U1 | Contradictory state during a test | Header reads "Testing…" while the body says *"Nothing is promised yet — run the test"* and **"4 SAMPLES, NOT YET RUN"**, and the CTA still reads "Run the test" |
| U2 | Overlapping controls | A floating "Testing…" pill renders on top of the "Keep building" / "Run the test" buttons |
| U3 | Frozen timer | "5s elapsed" never advanced across ~50s of wall clock |
| U4 | The hang | §1 — no timeout, no error, no escape but reload |

**All four were one bug** — the dead-zone throw in §1. Fixed together. Recorded as
four because that is how they presented: a single uncaught exception in a state
machine reads as four unrelated cosmetic faults, and chasing them individually would
have found none of them.

---

## 3. Fixed today (all deployed, tested, hand-mutation-checked)

Full reasoning for each is in `CLAUDE.md`; this is the index.

| v | Fix | Class |
|---|-----|-------|
| 1.6.4 | **An approval step's question is a message the promise-checker could not see** — made every approval workflow unpublishable-or-double-messaging | silent |
| 1.6.5 | **The 100s proxy ceiling is a SILENCE limit, not a time limit** — long builds died at 524; the two long POSTs now drip whitespace. Proven: a 140s build returned with `heldOpen:true` | destructive |
| 1.6.6 | **A Slack approval sent to an email reached nobody** (`chat.postMessage` takes an id, never an email) — the run would pause forever waiting for a question never sent | silent |
| 1.6.6 | The builder told users its own **Approve/Reject buttons don't exist** and offered a forgeable reply-with-a-word alternative | wrong + unsafe |
| 1.6.7 | **An unescaped quote truncated chat replies mid-sentence** — root cause of the long-documented `parsed:false` gotcha. Both truncations stopped exactly where a quoted word began | silent |
| 1.6.7 | The tool-turn reminder hardcoded `"ready_to_build":false` — instructing the model never to signal readiness | silent |
| 1.6.8 | **A restored "live" screen never re-checked it was still live** — "Running automatically", pulsing green dot, for a PAUSED workflow | silent |
| 1.6.9 | **The panel certified a case it had just disproved** — the negative example ("should not trigger") got a green tick moments after the workflow sent a DM for it | silent |
| 1.6.10 | **A scheduled run that delivered "ERROR: required data not found" was stored `success`** — and had formed a self-feeding loop; health read 100% | silent |
| 1.6.11 | **A finished build could be lost** (server had it, browser dropped it, nothing saved) **and a recovered build could never be finished** (a stuck local slice shadowed the server's finished spec) | destructive |

### Killed as non-bugs — do not re-investigate without new evidence

- **"Editing a workflow drops its promise."** It does not. Measured before/after on a
  live edit: contract 1571 → 1644 chars, statement rewritten to match the change,
  assertions and examples preserved. The 2026-07-19 PUT fix holds.
- **F14, "test runs inflate the live health numbers."** Does not reproduce. The
  dashboard reads `1 RUNS` with the test run listed separately and tagged `TEST`.

---

## 4. Residuals — carried, not fixed

- **A workflow can still read its own output.** The daily briefing delivered into the
  same inbox it reads; run 21:33:25 delivered message `19f48ccd106eb4ba` and run
  21:33:31 **fetched `19f48ccd106eb4ba`**. It now **fails loudly** (v1.6.10) instead of
  reporting success, but the cycle is still constructible. Generic fix: exclude mail
  the workflow itself sent.
- **The example generator omits fields the contract names.** After an edit added "the
  date the email arrived" to the promise, the generated examples' `expect` said
  `Date: <arrival date>` while their `given` carried only `from`/`subject`/`body`. The
  workflow delivered `*Date:*` with nothing after it. Live runs are likely fine (the
  real trigger supplies a date); the TEST cannot prove it.
- **F3** and the rest of `ui-test-findings-2026-07-19.md` — unchanged.
- **Background builds.** v1.6.5 removed the silence ceiling and v1.6.11 stopped a lost
  response destroying work, but a build still holds one long request open. Server-side
  jobs + polling remains the better long-term answer; it is no longer urgent.

---

## 5. Where Proof 3 stands

Three proofs were run against production to decide whether a demo could be recorded:

| Proof | Result |
|---|---|
| An arriving email fires a workflow | **PASSED** — real run 55s after the email landed |
| A workflow writes to Airtable | **PASSED** — 3 rows, columns mapped from the live schema |
| An approval gate works end to end | **BLOCKED** — builds and opens "Ready to test"; §1 stops the test |

The approval workflow (`ATLASGATE Email Approval Gate`, tenant `agntic`) is built,
9/9 approved, contract intact, and **now opens Ready to test** — that recovery is
itself the v1.6.11 fix working. It has never been run end to end.

**Do not record a demo featuring an approval gate until §1 is fixed and the gate has
been exercised with a real email — clicking REJECT first.** A gate that approves
proves nothing.

---

## 6. Method notes (these earned their keep today)

- **Every one of these was found by using the product, not by reading code.** The
  suite was green throughout.
- **Verify at the data layer.** "The panel says X" is not evidence. Read
  `memory/workflows/workflows.sqlite` and `memory/logs/atlas-events.log` directly;
  several findings inverted once the stored row was checked.
- **Assert what it SENT, not that it ran.** The negative-example bug was invisible
  until the delivered body was read out of the run table.
- **Watch the test go red.** Two guards written today initially SURVIVED mutation —
  and one test passed against a deliberately broken implementation because the case
  it named was filtered out before the code under test ran. Always `diff` to confirm
  the mutation applied, then confirm it fails.
- **A mutation run left a live mutant in the tree** when it timed out. Restore from a
  `cp` backup, never `git checkout` (see the CLAUDE.md hazard note).
- **A log line that contradicts your model of the failure is the finding.** The 227-
  second request in the event log is what proved the 524 was a silence limit — it had
  been read past twice.
