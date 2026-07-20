# Live UI test suite — findings (2026-07-19)

**Status: ALL SIX SHAPES EXERCISED.** Written during the run and appended to as each
shape was built. Five defects were fixed in-session (F21, F23, F29, F30, F32). Do not treat the absence of a finding
as evidence that a surface is clean — see [Coverage](#coverage) for what has actually
been driven so far.

## How to read this document

Per `CLAUDE.md`'s standing rules on remediation briefs:

- **Line numbers and file paths in this document are non-authoritative provenance.**
  They were true at the SHA below. Re-ground every finding against current code before
  acting on it. If your fresh grounding contradicts a finding here, **believe your
  grounding** and say so — refusing to fix a non-bug is correct discipline.
- Each finding states an **invariant** (what must be true) and a **behavioral,
  line-independent acceptance test** (how to prove it). Those two are the contract.
  The reproduction steps are a convenience, not the specification.
- Severity uses the P12 increment-loop calibration: a defect **BLOCKS** iff it is
  *(a)* reachable in production by a user or another tenant, **AND** *(b)* silent
  (looks like success) or destructive (data loss, cross-tenant leak, money moved).
  Everything else is a **RESIDUAL** — recorded, carried, not merge-blocking.

## Environment

| | |
|---|---|
| SHA at test start | `bd4edc2` (`chore(release): v1.6.0`) |
| App version | 1.6.0, confirmed live via `/health` |
| Host | local, `http://localhost:3000` |
| Account | `charles@agntic.co`, tenant `agntic` |
| Browser | headed Chrome via chrome-devtools MCP, operator-witnessed |

**Process freshness (load-bearing).** The server found running at session start was
**v1.5.5, booted 2026-07-17 11:50:10** — *before* five commits including
`34b2a43 fix(converger): stop the sufficiency check looping on valid specs`, which is
in-process backend code. It was **killed and restarted on the current tree** before any
testing. Per `CLAUDE.md`: a result from a stale process is not a result, it is noise
that looks like a finding.

**Purge performed.** All 140 `agntic` workflows (100 draft / 19 active / 11 paused /
10 error) plus their runs and versions were deleted at the operator's explicit
direction, and 92 builder-session `.jsonl` files were archived. Backups:
`<scratchpad>/dbbackup/workflows.sqlite` and `<scratchpad>/converger-archive/`.
The 19 active ones were live scheduled automations; this was surfaced and confirmed
before deletion.

---

## Findings

### F1 — Builder state in `localStorage` has an unbounded, silently-degrading ceiling

**Severity: RESIDUAL** (not silent-destructive; a server-side draft autosave partially
backstops it). Worth fixing because the failure mode is invisible to the user.

**What is true.** The builder persists the full build slice — spec, message history,
reasoning transcript, live node state, outcome contract — to `localStorage` under two
keys per build: a "current build" key and a per-workflow key
(`atlas_build_v1:<tenant>:<email>` and `atlas_build_wf_v1:<tenant>:<email>:<wfId>`).
Measured on this account: **21.6–28.4 KB per key, ~24 KB average.**

**Why it matters.** Per-workflow keys accumulate for every workflow the user keeps. At
~24 KB against a typical 5 MB per-origin quota, the ceiling is **roughly 200 retained
workflows**. The account under test had **140** — i.e. it was within ~30% of the wall
in ordinary use, not a synthetic stress case.

Both writes are `try/catch`-guarded and swallow the quota error. So the app does not
crash; instead **persistence silently stops working**. The user's in-progress build
stops surviving a reload, with no error, no warning, and no degraded-mode indicator.
This is the "silently degrades" class `CLAUDE.md` names repeatedly.

**What is NOT a defect (grounded, so the next agent doesn't chase it).** The in-app
delete path *does* clean up its key — `softDeleteWorkflow` calls
`localStorage.removeItem(this._buildKeyWf(wfId))` (the "R9" fix), and I verified that
code exists. The orphaned key I first observed was caused by **my own out-of-band SQL
purge**, not by any user-reachable path. Do not "fix" the delete path; it is correct.

**Invariant.** Builder draft persistence must either stay within quota for any workflow
count a plan permits, or tell the user when it has stopped persisting. Silent
best-effort persistence of state the user believes is saved is not acceptable.

**Acceptance test (behavioral, line-independent).**
1. Seed `localStorage` for one tenant/user with enough `atlas_build_wf_v1:*` keys to
   exceed the origin quota (e.g. ~220 × 24 KB).
2. Start a build, make a change that mutates the spec, reload the page.
3. **Today:** the change is gone and nothing was reported. **Required:** either the
   change survives (eviction/compaction of old keys kept it under quota), or the UI
   states that local recovery is unavailable.
4. Additionally assert the guard is load-bearing: with the quota handler removed, the
   test must fail. A guard no test can kill is pinned by nothing.

**Suggested direction (not prescriptive).** LRU-evict `atlas_build_wf_v1:*` beyond
N most-recent, and surface a one-line degraded-mode notice when a write throws. The
server-side draft autosave already exists and is the durable path; local storage should
be treated as a cache, not the record.

### F2 — A restored build session for a workflow that no longer exists renders a phantom

**Severity: RESIDUAL pending a reachability check** (see "What must still be proven").

> **Correction, recorded deliberately.** An earlier draft of this document claimed
> "the clean-slate canvas is an unexplained void with no empty state." **That was
> false and has been retracted.** The zero-workflow empty state exists and is good:
> *"No workflows yet. Tell Atlas what you'd like to automate and it'll build it with
> you, one step at a time"* + a **Build your first workflow →** button. I had been
> looking at a *build view restored from `localStorage`*, not the home view. The
> retraction is kept visible rather than silently edited out, because a handoff brief
> that quietly rewrites its own claims is exactly the stale-brief failure mode
> `CLAUDE.md` warns about.

**What is true.** When `localStorage` holds a build session whose `workflowId` no longer
exists server-side, the app restores that session and renders the **build view** rather
than falling back to home. Observed state: an empty canvas, a fully-populated right-hand
test panel (workflow title, "WHAT THIS MUST DELIVER" outcome contract, "Ready to test"),
and an enabled **Run test** button — all for a workflow with no backing row. The sidebar
also lists the phantom.

The restore is not validated against the server: nothing reconciles the restored
`workflowId` with the workflow list before rendering the build surface.

**Why it matters.** The user is shown a workflow that does not exist, in a state that
claims to be runnable. Whatever "Run test" does in that state, the UI has already made
a false claim before the click.

**What must still be proven (do not report this as a defect until you have).** I reached
this state through an **out-of-band SQL purge**, which is not a user path. Before acting,
establish whether a real user can reach it. The candidate paths, in order of likelihood:
1. **Two tabs / two devices.** Open a workflow's build view in tab A; delete that
   workflow in tab B; return to tab A and reload.
2. **Server-side loss** of a draft row that the client still has cached.

If neither is reachable, this is a hardening note, not a defect — record it as such and
move on. **Do not "fix" the in-app delete path**: it already removes its own key
(`softDeleteWorkflow` → `localStorage.removeItem(this._buildKeyWf(wfId))`, the "R9" fix),
and that code is correct. Verified during this session.

**Invariant.** A restored build session must be reconciled against the server before its
surface is rendered. The UI must never present a workflow as runnable when no backing
workflow exists.

**Acceptance test (behavioral, line-independent).** Put the client in a state where a
persisted build session references a `workflowId` the server does not have. Load the app.
Assert the user is either returned to home or shown an explicit "this workflow no longer
exists" state — and specifically assert that **no enabled "Run test" control is
presented** for the missing workflow.

### F3 — 🔴 The test panel certifies "4 real examples, every promise held" when no scenario was exercised

**Severity: BLOCKS.** User-reachable on the default path, silent, and it is the exact
gate that guards **Go live**. A user is told their workflow was verified against four
scenarios when zero of the named scenarios occurred.

**Reproduction.** Build the linear Shape-1 workflow ("every weekday at 8am, summarize
unread Gmail from the last 24h, post to `#agntic-x-slack`"), approve all steps, click
**Run test**. Panel returns:

> **Contract kept.** We ran 4 real examples through your workflow. Every promise held —
> it's cleared to go live.
> ✓ Multiple unread emails from past 24 hours
> ✓ Single unread email in last 24 hours
> ✓ No unread emails in past 24 hours
> ✓ Weekend trigger (should not run)

**What actually happened.** The Gmail account had **zero** unread mail. Expanding any
evidence row shows the *same* payload for all four:

> *What came back matched the deal — `{"messages":[]}`.*

The generated examples, read out of the persisted spec, are:

| id | label | `given` | `shouldTrigger` |
|---|---|---|---|
| e1 | Multiple unread emails from past 24 hours | `{}` | `true` |
| e2 | Single unread email in last 24 hours | `{}` | `true` |
| e3 | No unread emails in past 24 hours | `{}` | `true` |
| e4 | Weekend trigger (should not run) | `{"dayOfWeek":"Saturday"}` | **`false`** |

Every `given` is **empty**. The converger writes rich `expect` fixtures (full digests
with invented senders like `sarah@acmecorp.com`) but supplies **no input** to produce
them. So all four runs collapse onto whatever the live connector returns — one identical
empty result, relabelled four times. Confirmed in the event log: four `/workflows/run`
calls at `14:44:11/14/16/18`, each executing `fetch_unread → summarize_digest →
deliver_slack_a1`.

**Two independent defects are stacked here. Both must be fixed; fixing either alone
still leaves a false proof.**

**F3a — the example `given` cannot reach a connector-read workflow.** `given` *is* wired
to `initialContext` (`builder.js` → `dryRunSpecForTenant`), so the plumbing exists. But
this spec's trigger is `{"type":"schedule"}` — a schedule carries no event payload — and
its first node is a **connector read** (`gmail_search`, `query:"is:unread newer_than:1d"`)
that fetches live data regardless of seeded context. For any schedule-triggered workflow
whose data originates in a connector read — a very large fraction of real workflows —
**scenario variation is structurally impossible** with the current design. The oracle
runs one live query N times and reports N distinct verified scenarios.

**F3b — `shouldTrigger:false` is emitted and enforced by nothing.** `prompts.js:987`
instructs the model to emit `shouldTrigger`, and it does. A repo-wide grep finds exactly
three hits: that prompt line, and two unrelated `_shouldTrigger` matches in
`utils/middleware.js`. **No engine or oracle code reads `example.shouldTrigger`.** So e4
— whose own `expect` is `{"workflowExecuted": false}` — was *executed* and marked ✓
**kept**. A negative case that runs is not a negative case; the weekday-only trigger
gating is never verified, while the panel asserts it was.

**🔴 F3b CONFIRMED AT RUNTIME WITH SIDE EFFECTS (Shape 2, 2026-07-19).** The Shape-1
evidence for `shouldTrigger` being unread was static (a spec field nothing consumes).
Shape 2 produced hard runtime proof, and it is worse than "the row passes vacuously".

The fan-out workflow is scheduled **weekdays only** (`0 7 * * 1-5`). Its generated examples
included:

> ✓ **Saturday 7am — should NOT trigger (weekend)**

marked **passed**. The inbox store, queried directly after the run, contains **three**
messages from that test — one per example:

```
1. "Monday morning is not a reset — it's a run…"
2. "Thursday morning energy is real…"
3. "Saturday mornings are for the ones who show up anyway…"   ← the weekend example
```

**The negative example was executed, generated real content, delivered it to BOTH live
destinations (Slack and the inbox), and was then certified ✓ as evidence that it would not
run.** The panel's summary reads *"Contract kept … every promise held — it's cleared to go
live."*

So a "should not trigger" example does not merely pass without proving anything — it
**produces exactly the side effect it claims to prove cannot happen**, and reports that as
proof. Any workflow whose examples include a negative case will send real messages for it
on every test.

**Invariants.**
1. An example row may be marked ✓ only if the run actually exercised the scenario that
   row names. If the scenario could not be established, the row must say so — "not
   exercised" is an honest verdict; ✓ is not.
2. An example declaring `shouldTrigger:false` must **not** execute the workflow. The
   assertion is that it did *not* run.
3. Aggregate copy ("4 real examples, every promise held") may only count rows that
   satisfy (1).

**Acceptance tests (behavioral, line-independent).**
- **F3a.** Build a schedule-triggered workflow whose first step is a connector read.
  Generate examples. Assert every example whose label implies non-empty input either
  supplies input that demonstrably reaches the first step, or is reported as
  not-exercised. Specifically assert two examples with *different* labels cannot both
  pass on byte-identical run output.
- **F3b.** Construct an example with `shouldTrigger:false`. Assert `/workflows/run` is
  **not** invoked for it, and that the row passes iff no execution occurred. Mutate: make
  the harness run it anyway — the test must go red. (`shouldTrigger` is currently read by
  nothing, so today this test cannot fail — which is the point.)

**Note on scope.** `CLAUDE.md` already records a G-era residual that *"a trigger-fed llm
node's `given` must be a realistic sample event, not a label"*, treating it as
example-generation quality. F3 is **broader**: it is not merely thin fixtures, it is that
for connector-read workflows the fixture cannot matter at all, plus a declared negative
flag that nothing enforces. Please do not close it as the known residual.

### F4 — "Run test" performs real, irreversible deliveries with no warning

**Severity: RESIDUAL, but confirm the intent.** Real delivery in tests appears to be a
deliberate operator decision (there is a standing note preferring real Slack/Google/
Airtable delivery in e2e over dry-run scaffolding). Recorded because the *UI does not say
so*.

**What is true.** The right-hand panel is titled **TEST ENVIRONMENT**. Running the test
executed the `deliver_slack_a1` node **four times** (once per example) against the real
`#agntic-x-slack` channel. Nothing in the UI warns that clicking Run test posts real
messages to a real channel, nor that it does so once per generated example.

**Why it matters.** "Test environment" universally connotes a sandbox. A user testing a
workflow that emails customers, creates Airtable records, or posts to a company channel
will produce N real side effects per click. Combined with F3 (examples multiply), the
blast radius scales with a number the user never chose and cannot see.

**Invariant.** If a test performs real side effects, the UI must say so *before* the
click, and must state how many.

**Acceptance test.** Assert the run-test affordance discloses real-delivery semantics and
the example count before invocation, for any spec containing a write or delivery node.

### F5 — Post-run narration states things that did not happen

**Severity: RESIDUAL** (trust/credibility, not a functional break).

**What is true.** After the test, the chat narrated:

> *"Your Weekday Morning Email Digest workflow ran perfectly **this morning**! It searched
> your unread emails… and **successfully posted the results** to your #agntic-x-slack
> channel. Since there were no unread messages, it sent a nice clean notification…"*

Three problems in three sentences: it was a **test**, not a scheduled run; it did not run
"**this morning**" (it ran seconds earlier — the workflow has never run on schedule); and
it narrates one example's outcome ("no unread messages") as though it were the whole run,
immediately after the panel claimed four distinct scenarios passed. The narration and the
evidence panel contradict each other on the same screen.

**Invariant.** Post-run narration must describe the run that actually occurred, in the
tense and modality it occurred in, and must not contradict the evidence panel.

**Acceptance test.** Run a test on a never-scheduled workflow. Assert the narration
contains no scheduled-run or past-morning framing, and that any scenario it describes is
one the evidence panel also reports.

### F6 — The mandatory approval gate is mouse-only (accessibility)

**Severity: RESIDUAL by the silent/destructive calibration, but it is a hard blocker for
keyboard and screen-reader users** — the product cannot be used at all without a mouse.

**What is true.** Publishing requires approving every node ("Confirm every step to start
testing"). The approve/reject controls are revealed purely by CSS hover
(`.nodewrap:hover .nctrl{opacity:1;pointer-events:auto}`) and are `<span title="Confirm">`
/ `<span title="Reject">` — **not** buttons. Measured across all four nodes: zero
focusable elements, zero ARIA roles, zero aria-labels, zero `<button>`s. The nodes appear
in the accessibility tree as `StaticText` only.

**Why it matters.** This is not a peripheral surface; it is the only path from a built
workflow to a live one. There is no keyboard route through it.

**Invariant.** Every control on the required build→publish path must be reachable and
operable by keyboard, and exposed to assistive technology with an accessible name.

**Acceptance test.** With the graph built, Tab through the document. Assert each node's
confirm and reject controls receive focus in order, are activatable by Enter/Space, and
expose an accessible name. Assert the same via the a11y tree (button role, not
StaticText).

### F7 — Stale action buttons from earlier turns stay live

**Severity: RESIDUAL pending confirmation of consequence** (see below).

**What is true.** After the build completes and all steps are approved, the earlier
turns' **"Build it →"**, **"Approve & build →"** and **"Request a change"** buttons remain
in the transcript fully enabled — measured `disabled:false`, `pointerEvents:auto`,
`opacity:1`. The plan card is not collapsed or marked as acted-upon.

**Why it matters.** A user scrolling up to re-read the plan can click a control that
already fired. The likely consequence is a duplicate build that discards approval
progress, but **I have not yet clicked one, so the consequence is unconfirmed** — do not
report it as data loss without establishing that.

**Invariant.** An action button that has been consumed must not remain actionable.

**Acceptance test.** After a build completes, assert every prior-turn action control is
disabled or removed. Then click one and assert no new build starts.

### F8 — Three surfaces disagree about how many steps the workflow has

**Severity: RESIDUAL** (cosmetic, but it is a correctness-signal the user reads).

**What is true.** For the same 4-node spec: the plan card says **"3 STEPS"**, the test
panel says **"Building · 3 steps"**, and the graph says **"0 / 4 APPROVED"**.

The code states the intended rule explicitly — *"The trigger is the 'when', never a
step."* `_stepShape` honours it (`spec.nodes` excludes the trigger, which lives in
`spec.triggers[]`), giving 3. But the graph counter is
`total = S.liveNodes.length`, and `liveNodes` **includes** the rendered trigger node,
giving 4. A comment in the same file records an operator complaint about exactly this
class ("the plan said 3 STEPS, the panel 8 steps, the graph 9 APPROVED — three numbers
for one workflow"); plan and panel were reconciled, **the graph was not**.

**Invariant.** One workflow, one step count, computed one way.

**Acceptance test.** For a spec with a trigger and N non-trigger nodes, assert the plan
card, the test panel, and the graph approval counter all render the same number, and that
the number matches the documented rule.

### F9 — Sidebar keeps the placeholder name after the workflow is named

**Severity: RESIDUAL** (cosmetic).

**What is true.** Once the build completes, the title bar, test panel, and contract all
read **"Weekday Morning Email Digest"**, while the sidebar entry still reads **"New
workflow"** — through build, approval, and a completed test run. Earlier in the same
session the sidebar also showed **"Untitled workflow"** in the right panel while the
sidebar said **"New workflow"** — i.e. two different placeholders for one unnamed object.

**Invariant.** A workflow has one display name, everywhere, updated when it is named.

**Acceptance test.** Complete a build that assigns a name. Assert the sidebar entry text
equals the panel title.

### F10 — Minor copy defects

**Severity: RESIDUAL.** Grouped; each is small.

- **Composer references a control that isn't on screen.** While the plan card is showing,
  the composer placeholder reads *"Tell Atlas what to change — or click **Build it** ↑"*,
  but the button on screen is **"Approve & build →"**. The named control does not exist
  at that moment.
- **Promises "a couple", asks one.** The first converger reply opens *"A couple of quick
  things to nail down:"* and then asks exactly one question.
- **Instruction persists after it is satisfied.** With 4/4 approved and the counter
  reading "every step approved", the chat still instructs *"Now confirm each step in the
  flow — hover a step to approve it."*
- **Provenance mislabels a user-specified fact.** Plan step 03, *"Post the digest … to
  the existing #agntic-x-slack Slack channel"*, is tagged **I FOUND**, though the user
  named that channel verbatim in the opening intent. It should be **YOU SAID**.
  Provenance chips are a trust surface — they tell the user what to double-check — so
  mislabeling user-supplied facts as system-discovered decalibrates exactly the attention
  the feature exists to direct. (Plausible cause: the label reflects "I found this
  channel in your workspace", conflating *existence lookup* with *origin of the
  requirement*. Those are different claims and need different chips.)
- **"ON FAILURE" describes a happy-path edge case.** The plan's ON FAILURE reads *"If no
  unread emails are found … the digest will note that the inbox is clear"* — an
  empty-input case, not a failure. Nothing states what happens if Gmail auth expires or
  Slack is unreachable. A user reading ON FAILURE will believe failure is handled.

### F11 — 🔴 The outcome contract is DROPPED on publish. It has never been persisted, for any workflow.

> **✅ FIXED 2026-07-19** (`src/api/builder.js`, the **PUT** handler).
>
> **⚠️ Correction, recorded deliberately (fourth in this document). The SYMPTOM was
> exactly right; the MECHANISM below is WRONG.** The finding blames the POST body
> (`{ spec, intent, testRun }` omitting `S.outcome`). Re-grounded against current code,
> that chain does not break: `S.spec` **does** carry `outcome` (`spec-assembler.js`
> `assembleSpec` sets `{version:2, outcome}`; the `generated_workflow` and `ratify`
> interrupts both carry it), and the POST handler's `{ ...spec }` spread therefore
> passes it to `create()`, which stores it. `S.outcome` is a *derived UI pin*, not the
> transport. Verified by direct call: `assembleSpec` → `version:2, assertions:1`.
>
> **The real cause is that the POST branch is nearly unreachable.** `_ensureDraft`
> (`public/index.html`) creates the backing draft row on the **first message**, so
> `S.workflowId` is always set by the time the user approves, and `_saveWorkflow`'s
> `const isUpdate = !!S.workflowId` sends a **PUT**. The PUT handler enumerated its
> fields and omitted `outcome`, which `workflowService.update` correctly reads as
> *inherit* — and the inherited value is the draft row's, and a draft row is born
> without one. So the contract was dropped on every publish, which is why the
> distribution is 100% NULL rather than merely common.
>
> **Fix:** the PUT patch now carries `...(spec.outcome !== undefined ? { outcome: spec.outcome } : {})`.
> The `undefined`-vs-`null` distinction is preserved: absent still INHERITS (a caller
> that knows nothing about outcomes cannot wipe one), explicit `null` still RETRACTS.
> Verified against a real store: a draft row created with `outcome=NULL, spec_version=1`
> updates to a persisted contract with `spec_version=2` and its assertions intact.
>
> **Lesson worth keeping:** the brief's evidence (148/148 NULL) was sound and its
> reasoning was not, and the two had to be *reconciled* rather than one believed over
> the other. Had I trusted the mechanism I would have "fixed" a correct POST handler
> and shipped the bug; had I trusted the fresh grounding alone I would have closed a
> real defect as a non-bug. Both were necessary.

**Severity: BLOCKS.** Silent, universal, and it disables the central artifact of P12
Increment C plus two of Increment G's three deliverables.

**What is true.** `workflows.outcome` is **NULL** for the workflow published in this
session. It is not a one-off. Against the pre-purge backup of this account
(`<scratchpad>/dbbackup/workflows.sqlite`, 148 rows):

| spec_version | outcome IS NULL | count |
|---|---|---|
| 1 | yes | 146 |
| 2 | yes | 2 |

**Every workflow ever published on this account has a NULL outcome** — including the two
stamped `spec_version = 2`, which advertise a v2 contract they do not carry.

**Mechanism (grounded end to end).** The persistence path is present and deliberate —
`workflow-service.js` carries an emphatic comment that the contract *"MUST reach the
[store] … a spec that dropped its own outcome on the way in cannot be checked against
it"*, and `workflow-store.js` has an `outcome` column plus JSON handling. The break is on
the **client**: the builder holds the contract in a state field **sibling** to the spec
(`S.outcome`), while the publish request body is assembled as
`{ spec, intent, testRun }` — `S.outcome` is never included. The server then spreads
`...spec`, which has no `outcome` key, so `create()` receives none, stores NULL, and
derives `spec_version = 1`.

**Consequences, each verified in the running app:**
1. **`UNSATISFIED_ASSERTION` cannot fire on any stored workflow.** The publish-time
   contract check is the moat of Increment C; with no stored contract there is nothing
   to re-check on any subsequent edit, migration, or re-validation.
2. **The SOP does not carry the contract.** Increment G's deliverable #2 was that the
   SOP carries the outcome contract, the escalation policy, and the provenance. The
   rendered SOP for the live workflow contains **none of the three** — it is trigger +
   three steps. It cannot contain them: it is "generated from the live spec", and the
   live spec has no contract.
3. **`spec_version` lies.** Two historical rows claim v2 with no contract present.

**Invariant.** A contract shown to the user in the builder and used to gate "Go live"
must be the same contract stored with the workflow. If the contract cannot be persisted,
publish must fail loudly rather than silently storing a v1 workflow.

**Acceptance test (behavioral, line-independent).** Build any workflow that produces an
outcome contract. Publish it. Assert the stored row has a non-NULL `outcome` whose
statement and assertions match what the builder displayed, and `spec_version = 2`. Then
assert the SOP rendered from that stored row contains the contract. Mutate: strip
`outcome` from the publish payload and confirm the test goes red — today it would stay
green, which is why this shipped.

### F12 — 🔴 "Contract kept · every promise held" is certified on ZERO examples

> **✅ FIXED 2026-07-19** — together with **F16**, via the `not_exercised` verdict this
> document's synthesis asks for ("Add `not_exercised` first"). See the shared note at
> the end of F16; the two are one fix because they are the two halves of one missing
> concept.

**Severity: BLOCKS.** Silent, user-reachable in two clicks, and it is the gate on **Go
live**. This is a vacuous truth rendered as a verification.

**Reproduction (exact, from this session).**
1. Build and publish the Shape-1 workflow. It has 4 generated examples.
2. Click **Edit workflow** and make one ordinary change in chat: *"instead of weekdays at
   8am, run it every 2 minutes."* Atlas correctly rewrites the cron to `*/2 * * * *`.
3. The edit **clears `outcome.examples` from 4 to 0** (`outcome.assertions` survives at 1).
4. Click **Run test**. The panel returns:

> **Contract kept.** We ran **0 real examples** through your workflow. Every promise held
> — it's cleared to go live.
> **THE EVIDENCE · 0 REAL EXAMPLES**

Zero rows of evidence, and a green **Go live**. Screenshot:
`tmp-g-verify/T15-zero-examples-passed.png`.

**Why it matters.** The empty set satisfies "every promise held" vacuously. This is
precisely the failure class `CLAUDE.md` names — *"a default that makes a check vacuous is
not a safety net; it is the bug"* — sitting in the flagship verification surface. It is
reachable by the most ordinary action a user can take on a live workflow: editing it.
Combined with **F3**, the test panel can be made to certify a workflow either on
scenarios it never exercised, or on no scenarios at all.

**Reproduced again on the approval-gate shape, with the contract ALSO empty (2026-07-19).**
After F21 was fixed, Shape 4 was approved 16/16, reopened from its saved draft, and tested.
The panel returned:

> **Contract kept.** We ran **0 real examples** through your workflow. Every promise held —
> it's cleared to go live.
> **THE DEAL** *(blank — no statement at all)*
> **THE EVIDENCE · 0 REAL EXAMPLES**

…with a green **Go live**. Screenshot: `tmp-g-verify/T23-shape4-tested.png`.

**This is F11 + F12 + F16 compounding on the product's highest-stakes shape.** The draft
was reloaded from the server, where `outcome` is NULL (**F11**), so the contract statement
renders empty and the example list is gone; zero examples is then certified as a pass
(**F12**); and the one run that did occur took the `not_support` path, so the approval gate
never executed (**F16**) — the chat narration says so explicitly: *"identified it as not a
support email and stopped processing there."*

So a workflow that emails customers, gated by a human approval that was **never once
exercised**, against a contract that is **literally blank**, is presented as verified and
cleared to go live. Every individual finding is visible in a single screenshot.

**Invariants.**
1. Zero examples is **not** a pass. With no examples the verdict must be "not verified",
   and **Go live** must not present as cleared.
1b. An **empty contract statement** must never be certified. If THE DEAL is blank there is
   no promise to have kept, and "every promise held" is vacuously true — the F12 defect
   through a second door.
2. An edit that invalidates the examples must regenerate them, or mark the contract
   unverified until they are.

**Acceptance test.** Drive a spec to `outcome.examples.length === 0` and run the test.
Assert the verdict is not "kept"/"passed" and the go-live control is not enabled on the
strength of it. Separately assert that editing a published workflow leaves
`examples.length > 0` or flips the panel to an explicit unverified state.

### F13 — The contract statement goes stale against the spec it describes

**Severity: RESIDUAL** on its own; compounds F12.

**What is true.** After the schedule edit, `spec.triggers` is
`[{"type":"schedule","cron":"*/2 * * * *"}]` while `outcome.statement` still reads *"Every
weekday at 8am, summarize all unread emails …"*. The stale sentence is what the panel
renders as **THE DEAL**, directly above the certification. So the workflow was certified
"cleared to go live" against a promise describing a schedule it no longer has.

The chat itself narrated the change correctly (*"Updated the schedule trigger's cron
expression from weekdays at 8am ('0 8 * * 1-5') to every 2 minutes ('*/2 * * * *')"*) —
the spec was updated, the contract was not.

**Invariant.** When an edit changes something the contract asserts, the contract is
restated or explicitly invalidated. A contract that describes a previous version of the
spec is worse than none — it reads as authoritative.

**Acceptance test.** Edit a workflow's trigger, destination, or content step. Assert
`outcome.statement` either reflects the change or the contract is marked stale, and that
no certification is offered against a stale statement.

### F14 — Test runs are counted in the live workflow's success metrics — **FIXED 2026-07-20**

**Severity: RESIDUAL** (metric hygiene).

**What is true.** Immediately after publishing, the console read **"100% success · 1
RUNS · 0 ERRORS"**, where the single run was the pre-publish **TEST** run (the run
history row is badged `TEST`). Test runs are correctly exempt from plan caps, but they
are included in the dashboard's success rate and run count.

**Why it matters.** The live dashboard is where an operator judges whether an automation
is healthy. Seeding it with test runs — which are the runs most likely to have been
re-run until green — inflates the health signal for a workflow that has never actually
fired on schedule.

**Acceptance test.** Publish a workflow after a passing test. Assert the console's run
count and success rate reflect only non-test runs, or that test runs are visually
segregated from the headline metric.

**FIXED 2026-07-20.** Pinned by `tests/api/console-health-metrics.test.js` (9 tests, at
the HTTP layer against a real SQLite store — a predicate-only test would stay green if
the route reverted).

- **This reversed a DELIBERATE decision.** Commit `c3aad3c` (2026-07-03, "Q13") *removed*
  an existing `.filter(r => !r.is_test)` on purpose, so the band's run count would agree
  with the run-history list beneath it. That concern was real; the remedy made the band
  untrue. The fix **separates rather than hides**: `GET .../metrics` counts live runs and
  additionally returns `tests`, so the band renders *"not yet run live · 1 test run"*, and
  the run-history list still lists test runs with their `TEST` badge. Both numbers are now
  true and they no longer contradict each other.
- **A second surface, never filed, had the identical defect.** `src/api/builder.js:1727`
  computed the Home dashboard's platform-wide `success_rate` module and `top_workflows[]`
  success rates over the same unfiltered `getRuns` — so a workflow that had only ever been
  test-run showed a 100% success rate on the *first screen of the product*. Fixed in the
  same pass. (`isDoneRun` at `builder.js:688` already excluded test runs, so the file's own
  policy was right and the per-workflow counts simply never followed it.)
- **One definition, not three.** `isLiveRun` now lives in `src/workflows/time-saved.js`
  beside `isValueRun` (which is re-expressed in terms of it) and is imported by both
  surfaces. Three copies of `!r.is_test` is three chances to disagree, and the disagreement
  is silent.
- **Cost is unchanged and deliberately so:** a test run costs real money, so it still
  counts toward `costUsd`. That is spend, not health.
- **Verified in a headed browser** (2026-07-20, operator-witnessed) against an isolated
  instance seeded with the two shapes. Both surfaces render correctly:
  - *Support Email Auto-Reply* (1 test, 0 live) — band reads **"— · not yet run live ·
    1 test run"**, `0 RUNS / 0 ERRORS`, while the run-history list below still shows the
    run with its `TEST` badge. Previously: *"100% success · 1 RUNS · 0 ERRORS"*.
  - *Weekday Morning Digest* (2 test, 3 live: 2 ok / 1 error) — band reads **"67% success
    · last 5m ago · 2 test runs"**, `3 RUNS / 1 ERRORS`, with all five rows listed. **This
    is Q13's concern resolved rather than traded away:** the band says 3, the list shows 5,
    and the caption explains the difference.
  - Home dashboard: *Support Email Auto-Reply* now contributes `runCount 0, successRate "—"`
    to `top_workflows` (was 1 run / 100%), and the platform `success_rate` module reads
    **67% over 3 runs** (was 83% over 6).

### F15 — SOP trigger section is boilerplate, not the actual trigger

**Severity: RESIDUAL** (cosmetic, but the SOP is a customer-facing export).

**What is true.** The SOP's TRIGGER block reads *"Fires on the configured trigger
event."* for a schedule-triggered workflow, while the page header immediately above
correctly shows `Scheduled (*/2 * * * *)`. The SOP is exportable to PDF and Markdown and
is the artifact handed to a customer or auditor; "fires on the configured trigger event"
tells the reader nothing.

**Acceptance test.** Render the SOP for schedule, email, and connector-event triggers.
Assert each states its actual trigger condition in plain language.

### F16 — 🔴 A 3-lane router is certified "every promise held" after exercising only the do-nothing lane

**Severity: BLOCKS.** Silent, user-reachable, gates **Go live**. This is the sharpest
instance of the F3 pattern and the clearest to act on, because here the promises are
concrete and the evidence of non-coverage is explicit in the UI.

**Reproduction.** Build Shape 3: *"When a new email arrives, classify it urgent /
billing / general. Urgent → post to `#agntic-x-slack`. Billing → save to Atlas inbox.
General → do nothing."* Approve all 9 nodes, **Run test**.

**Structure is correct** (this part passes — see Verified working): `branch.on` is
`classify_email.output`, all three cases are members of the classifier's categories, and
the mandatory `*` catch-all is present.

**What the panel reports.**

> **Contract kept.** We ran 1 real example through your workflow. Every promise held —
> it's cleared to go live.
> **THE EVIDENCE · 1 REAL EXAMPLE**
> ✓ *Connect your tools to Stripe with the App Marketplace — Stripe
> `<updates@e.stripe.com>`*

**What actually ran.** Expanding the row shows the branch verdict:

```
{"value":"general","matched":"general","to":"stop_general","viaCatchAll":false}
```

The one sample classified as **general** and routed to **`stop_general` — the lane that
does nothing.** The executed nodes, from the event log, were exactly:
`extract_email → classify_email → route → stop_general`. **No delivery node ran at all.**

**So the contract's two delivery promises — "urgent emails post to #agntic-x-slack" and
"billing emails are saved to the Atlas inbox" — were never exercised, and both were
reported as held.** The single certified sample is the one path that satisfies neither.

**Why this is distinct from F3.** F3 is about fixtures that cannot reach the workflow.
F16 is about **path coverage**: the example picker did its job (it pulled a *real* typed
email — the F-increment feature works), but nothing requires the sample set to cover the
branch's lanes. A router's entire value is the routing; one sample can only ever prove
one lane. The oracle nevertheless aggregates to "every promise held".

**Note the interesting contrast, which is diagnostic.** Shape 1 (schedule trigger +
connector read) got **4 fabricated examples with empty `given`**. Shape 3 (email trigger)
got **1 real example pulled from the live inbox**. The example machinery behaves
completely differently depending on whether the trigger carries a payload — and neither
mode produces lane coverage.

**Invariants.**
1. A spec containing a `branch` may only be certified if the samples collectively reach
   every lane, **or** the uncovered lanes are named as unverified in the panel.
2. An assertion may be reported as held only if a run actually exercised it. An
   assertion whose delivery node never executed is **unproven**, not satisfied.

**Acceptance tests (behavioral, line-independent).**
- Build a 3-lane router. Run the test with samples that all take one lane. Assert the
  verdict is **not** "every promise held", and that the two unexercised lanes are named.
  Mutate: make the aggregator ignore lane coverage — the test must go red.
- Assert an assertion whose target delivery node did not appear in the run's executed
  steps is reported unproven. Today the run above satisfies both assertions with zero
  deliveries, so this test currently cannot pass.

**✅ THE REPORTING HALF IS FIXED (2026-07-19) — the coverage half is not. Read both.**

`evaluateExampleRun` (`src/workflows/outcome-oracle.js`) now returns **`verdict`**
(`'kept' | 'broken' | 'not_exercised'`) and **`enforced`** (how many assertions this run
actually CHECKED — a skipped lane is not a check). A promise is `kept` only if
`enforced > 0`; the empty set and the all-skipped set both resolve to `not_exercised`.
The client certifies on `verdict`, so:

- **F12** — zero examples, or a contract nothing exercised, renders *"not verified"* with
  a new `testState: "unverified"`. `reviewDraft()` gates on `testState === "passed"`, so
  **Go live stays locked** rather than presenting green over no evidence. The structural
  fallback survives **only** for a spec carrying no contract at all — there is nothing to
  certify there, so "it ran cleanly" is the honest bar and v1 workflows publish unchanged.
- **F16** — the do-nothing-lane router now reports each unexercised promise by name
  (*"it took a path that doesn't cover slack:#x"*) instead of ✓.

**`contractPassed` was deliberately LEFT UNCHANGED**, and this is the load-bearing part.
The converger's `verify` node reads it to decide whether to regenerate; flipping it false
for an unexercised lane is precisely how a valid draft gets thrown away and rebuilt until
the build gives up — **F17**. This document's synthesis predicted that exact regression
("naïvely making the oracle stricter without adding the third verdict will convert false
passes into F17-style build failures"), and it is why the fix ADDS an answer rather than
flipping the sign of the existing one.

**Verified with the mutation, per the document's own warning.** Deleting the `enforced > 0`
floor flips both the zero-assertion case and the do-nothing-lane router back to `kept` —
the defect restored verbatim — while a genuinely delivering run still reads `kept` and a
genuine miss still reads `broken`. So the guard is load-bearing and narrow.

**✅ THE COVERAGE REQUIREMENT IS NOW CLOSED TOO (2026-07-19).** `laneCoverage` /
`laneInventoryOf` in `outcome-oracle.js` judge the SAMPLE SET, not each example: a lane is
a distinct `(branch, target)` pair, a run's lane is read from the branch's OWN recorded
output, and any lane no sample reached BLOCKS certification and is **named in the user's
own case words** ("nothing went down 'urgent' or 'billing'"). The F16 router now reports
1/3 lanes covered instead of "every promise held".

Three design choices, each load-bearing:
- **A lane is a TARGET, not a route VALUE.** A decision table sending P2 and P3 to the same
  "stay quiet" step has one lane there. Per-value coverage would demand a sample per enum
  member and be unreachable on exactly the tables that most need it.
- **The lane taken is read from the branch's own `{value, matched, to}` output**, never
  re-matched here. Re-deriving it would be a second copy of `branch.run()`'s selection
  rule, and `decision-analysis.js` proved twice that two copies of one rule diverge.
- **The client holds NO copy of the rule.** The lane inventory ships with each result and
  the browser does set subtraction, so the page and the engine cannot disagree about what a
  lane is.

*(Note on the approach: reusing `decision-analysis.js`'s box subtraction — the obvious
"don't invent a second notion of coverage" move — was considered and rejected. It answers a
BUILD-TIME question, "which input combinations do these rules fail to cover," which is not
the run-time question "which lanes did the samples fail to exercise." The correct shared
primitive was `closedDomainOf`/`normalizeCases`, which the oracle and the validator's moat
already share.)*

**Still open:** **F3**'s fixture generation — for a schedule-triggered workflow whose first
step is a connector read, no seeded `given` can reach the workflow at all, so lane coverage
can report the gap but example generation still cannot close it.

### F17 — 🔴 The human-approval shape fails on natural phrasing: a valid 12-node spec is discarded and the user is asked to re-explain

> **Correction, recorded deliberately (second in this document).** An earlier revision of
> this finding stated that Shape 4 was *"unbuildable through the product"* because both
> attempts failed. **That was wrong and is retracted.** Attempt 2 **succeeded** — it
> completed at ~13:24, several minutes after my monitoring window closed, producing a
> 16-node workflow (*"Support Email Auto-Reply with Approval"*) awaiting node approval.
> I called the failure before the build had finished. The corrected picture is below.
> The retraction is left visible because a handoff brief that silently rewrites its own
> claims is the stale-brief failure mode `CLAUDE.md` warns about — and because
> "unbuildable" would have sent the next agent hunting a defect that does not exist.

**Severity: BLOCKS.** Not silent in the "looks like success" sense — it visibly fails —
but it is user-reachable on the product's highest-stakes shape, it **discards correct
work**, it costs **6.3 minutes to fail**, and its message **misattributes the failure to
the user's phrasing**. It is recoverable (see below), so it does not make the approval
gate unreachable; it makes the natural way of asking for one fail expensively.

**Corrected outcome of the two attempts.**

| | Phrasing | Result | Duration |
|---|---|---|---|
| 1 | Natural prose ("ask me to approve the draft in Slack…") | **FAILED** — *"I couldn't assemble the workflow from that"* | 6.3 min |
| 2 | Explicit numbered steps (what the error asked for) | **Succeeded** — 16 nodes, awaiting approval | ~8 min |

So the shape **is** buildable, but only after a failed first attempt and a manual
re-specification, ~14 minutes end to end. A non-technical operator — the stated target
user — is unlikely to recover from attempt 1 on their own, and the error text actively
misleads them about why it failed.

**Reproduction.** New workflow → *"When a customer support email arrives in Gmail, draft
a polite reply. Before sending anything, ask me to approve the draft in Slack. Only send
the reply by email if I approve it — if I reject it, don't send anything. Build it now,
don't ask me questions."* → **Build it** → **Approve & build**.

**What the user sees.** ~9 minutes of a static `Building…` label, then:

> *"I couldn't assemble the workflow from that. Could you describe, step by step, what it
> should do?"*

**What actually happened.** The converger **had already assembled a correct spec.** The
last checkpoint of session `build-agntic-1784484376335` holds a complete 12-node,
11-edge draft:

```
extract_email(llm) → classify_support(llm) → route_support(branch)
  → stop_not_support(stop)
  → draft_reply(llm) → compose_dm(llm) → deliver_slack_a1(deliver)
     → approve_reply(human) → route_approval(branch)
        → stop_rejected(stop)
        → format_email_reply(llm) → deliver_gmail_a2(deliver)
```

The human node is **correctly formed against every D-increment invariant**:

```json
{ "prompt": "Review the draft support reply above…",
  "decisions": ["approve","reject"],
  "timeout": { "after": "24h", "then": "reject" } }
```

Timeout defaults to **reject** — silence does not become consent — and the answer is
routed through `route_approval` to `stop_rejected`, so it is a real gate, not a `human`
node alone. This draft is *better* than what the failure message implies the system
could not produce.

**The failure is a clarification interrupt, not an error.** From the event log:

```
"kind":"respond.ok", "sent":"accept", "interrupt":"clarification", "ms":376822
```

`respond.ok` — the graph completed successfully and *chose* to interrupt for
clarification, after **376.8 seconds** on a single request. So the sufficiency/analysis
step judged a valid, complete, correctly-gated spec to be insufficient and threw it away.

**The transcript contradicts itself in two adjacent sentences.** The reasoning stream's
final lines, immediately above the failure message, verbatim from the running app:

> *"…I'm noticing a potential issue where `format_email_reply` expects input from
> `draft_reply.output`, but its incoming edge comes from `route_approval`… Actually,
> since steps can access any previous output regardless of edge connections, and `input`
> is a valid config key for LLM nodes, explicitly referencing `{{draft_reply.output}}`
> should work fine.* ***The workflow looks complete.***"
>
> *"**I couldn't assemble the workflow from that.** Could you describe, step by step, what
> it should do?"*

The model self-audited the spec against the branch/terminal/human-timeout rules, found
one concern, resolved it correctly, and concluded **"The workflow looks complete"** — and
the very next line on screen tells the user it could not be assembled. Whatever rejects
the spec is **downstream of, and disagrees with, the reasoning the user is shown**. That
disagreement is the bug; the user-facing message is merely how it surfaces.

**ROOT CAUSE — found verbatim in the reasoning stream, and it is F16 wearing a different
mask.** The converger's verify step ran the spec against a real sample and reported:

> *"The workflow ran, but a promised delivery didn't happen on a real sample (`Connect
> your tools to Stripe with the App Marketplace — Stripe <updates@e.stripe.com>`):
> **can't check — it happens only when "approved", but no step here can produce
> "approved"** (the routes are: support, not_support, approve, reject, timeout) — **that
> promise can never be checked. Let me rebuild it** so every step the outcome depends on
> is wired correctly."*

Trace it through:
1. The sample drawn from the live inbox is a **Stripe marketing newsletter**.
2. It classifies as `not_support`, so the run correctly stops at `stop_not_support`.
3. The approval path therefore never executes — **correctly**, for that input.
4. The outcome checker sees the `approved` assertion unexercised and concludes the
   promise **"can never be checked"** — i.e. it reads *"this sample did not reach that
   path"* as *"no step can produce that value"*, which is false: `approve_reply` produces
   exactly it.
5. On that false conclusion it **discards the valid spec and rebuilds**, repeatedly,
   until it gives up with *"I couldn't assemble the workflow from that."*

**This is the same defect as F16, inverted.** Both come from one conflation:

> **"this path was not exercised by this sample" ≠ a verdict about the path.**

- In **F16** (and F3) the unexercised path is resolved **optimistically** → reported as
  *"every promise held"* → **false pass**.
- In **F17** the unexercised path is resolved **pessimistically** → reported as
  *"can never be checked"* → **false failure, and an expensive rebuild loop.**

The correct third answer — **"not exercised by this sample"** — does not exist in the
system. Fixing F16 by teaching the oracle that unexercised ≠ satisfied will, if done
naïvely, make F17 *worse* (more things become "unverifiable"). **Fix them together:
introduce `not_exercised` as a first-class verdict that neither passes nor triggers a
rebuild, and drive sample selection to cover the paths instead.** This is the single most
important structural note in this document.

**Secondary, and also a real gap:** the sample set is the reason the approval path is
never reached — one newsletter cannot exercise a support-email branch. Whatever fixes
F16's lane coverage should feed the converger's own verify step, not just the user-facing
test panel.

**Direct evidence of the loop, sampled every 25s from the session checkpoints.** Format is
`phase / draft-node-count / checkpoint-count`:

```
13:14:51  proposing   12   9
   …          (8 samples, unchanged)
13:18:11  ratifying   12  14     ← reached ratification
   …          (6 samples)
13:20:42  proposing   12  15     ← REJECTED, fell back to proposing
   …
13:22:22  proposing   12  17
13:24:02  finalizing  12  22     ← finally converged
```

**The draft node count never moves off 12.** Across ~10 minutes and 22 checkpoints the
converger re-derives the *same* spec, reaches `ratifying`, rejects it, and drops back to
`proposing`. This is the `ratify → reject → re-propose` cycle, and it is burning an
architect-tier model call per lap. It is also why F18 (no progress indication) hurts so
much here: from outside, ten minutes of identical state.

**On the prior fix.** `34b2a43 fix(converger): stop the sufficiency check looping on
valid specs` is in the running build (verified — the server was restarted onto it before
testing), so this is either a shape it does not cover or a second path to the same
behaviour. **Re-ground it; do not assume that commit is the cause.**

**Invariants.**
1. If the converger holds a spec that passes validation, it must not discard it and
   report inability to build. It may ask a *narrowing* question while retaining the
   draft, but the work must survive.
2. A failure message must not attribute the failure to the user's phrasing when the
   system in fact produced a valid artifact.

**Acceptance test (behavioral, line-independent).** Drive the approval-gate intent above.
Assert the build terminates in a graph the user can approve. Separately, assert the
weaker invariant that is independently valuable: whenever the converger raises a
clarification interrupt, any draft it holds is preserved and re-offered rather than
dropped. Mutate: force the sufficiency check to reject a known-valid spec and confirm the
test goes red.


### F18 — A 6-minute build shows no progress, and the promised step-by-step assembly never appears

**Severity: RESIDUAL** on its own; it is what makes F17 expensive rather than merely
wrong.

**What is true.** The v1.6.0 release note promises *"Watch your workflow assemble step by
step"*, and the build screen states *"follow my thinking below as I build your workflow.
**Each step will appear in the flow as I add it.**"* Neither happened.

Measured at ~7 minutes into the build, with the server-side draft already holding **12
nodes** for several minutes, the client state was:

```
phase: "building",  liveNodes: 0,  reasoningSegs: 2,
specNodes: 0,       DOM .nodewrap count: 0
```

The graph was empty for the entire build. The user's only feedback for ~9 minutes was a
static `Building…` label — no node count, no elapsed timer, no phase, no cancel control.
By contrast Shape 1 built in ~50s and Shape 3 in ~118s, so this surface is untested at
the durations where it matters most.

**Why it matters.** A user cannot distinguish "working hard" from "hung" from "crashed".
Nine minutes of an unchanging label on a screen that promised live assembly reads as a
frozen app; the rational user reloads or re-clicks, and F7 (stale live action buttons)
means a re-click can start a second build.

**Invariant.** While a build is running, the UI must show progress that changes — nodes
as they are added, or at minimum a phase and elapsed time — and must offer a way to
cancel.

**Acceptance test.** Drive a build that takes >2 minutes. Assert nodes appear in the
graph as the server-side draft grows (assert client node count reaches the server's
before completion), and that a cancel affordance exists.

### F19 — Raw model deliberation is rendered to the user on failure

**Severity: RESIDUAL** (trust/polish).

**What is true.** The "How Atlas thought through this build" panel is a deliberate
feature and reads well in the successful builds. On this failed build it expanded to a
wall of unedited first-person deliberation, including internal node identifiers and
visible uncertainty:

> *"So the question is whether sending the approval request via Slack DM actually
> satisfies the `deliver_slack_a1` requirement, or if that's a separate step… **Actually,
> I think the key insight is that fan-out is allowed here** — after the content assembly,
> I can have one edge going to `deliver_slack_a1`…"*

**Why it matters.** Paired with *"I couldn't assemble the workflow from that"*, the user
is shown several screens of the system reasoning confidently and in detail, and then told
it did not understand them. The transcript visibly contains the correct answer. This
reads as either dishonest or broken, and it is the failure path — the moment the product
can least afford it.

**Acceptance test.** Force a build failure. Assert the user-facing surface presents a
summary of what was attempted and what is needed, not the raw deliberation stream, and
that internal node ids do not appear in prose shown to the user.

### F20 — "Approve in Slack" (as a DM) is not expressible; the request silently degrades to the inbox

**Severity: RESIDUAL** (capability gap + silent substitution).

**What is true.** The user asked, in plain words, to *"ask me to approve the draft in
Slack."* The converger worked the problem explicitly and concluded, verbatim from the
reasoning stream:

> *"Now I'm checking what channel types are actually available for the human node — it
> looks like `"inbox"`, `"slack"` with a target, or `"email"` with a recipient, but
> **there's no direct `"slack_dm"` type**. So I'll use a fan-out approach: the compose_dm
> step sends the formatted message to Charles via `deliver_slack_a1`, while a separate
> human approval node uses the **inbox** channel to request his decision."*

So the approve/reject buttons land in the **Atlas inbox**, while Slack receives a
notification with no buttons. The user asked to approve in Slack and got neither an
error nor a disclosure — the plan document's step 05 still reads *"Send Charles a Slack
DM … and ask him to approve or reject"*, which is not what the spec does.

**Two separable issues.**
1. **Capability gap.** The `human` node's `slack` channel takes a *channel* target; there
   is no DM form. Approval-by-DM is a natural and probably common ask.
2. **Silent substitution.** When a requested approval channel is unavailable, the system
   substitutes another and the plan continues to describe the requested one. The user
   would discover this only when the buttons failed to appear in Slack.

**Worth noting the guard that DID fire correctly** — the reasoning also shows:
*"since we're actually sending an email, I can't use email-only approval; I'll switch to
inbox so it's a stronger validation."* That is `WEAK_APPROVAL_FOR_WRITE` working exactly
as designed, reasoned about explicitly. **Do not weaken it while addressing this.**

**Invariant.** If a requested approval channel cannot be used, say so; never substitute
silently while the plan continues to promise the requested channel.

**Acceptance test.** Request approval on a channel the `human` node cannot serve. Assert
the user is told, and that the plan document does not describe the unavailable channel as
if it were configured.

---

### F21 — 🔴 An unrendered node freezes the approval queue: the workflow can never be tested or published

> **✅ FIXED in this session** (`public/index.html`, `_liveLanes`). Operator asked for the
> fix so Shape 4 could be finished. See "Fix applied" at the end of this finding. The
> description below is kept as the record of the defect and its acceptance test.

**Severity: BLOCKS.** Terminal, silent, and it strands a completed build permanently. This
is the defect that stopped Shape 4 from being finished end to end.

**What is true.** The approval queue is **sequential and index-ordered**: exactly one
`.nctrl` control exists in the DOM at a time, for the node at index `liveConfirmed`. If
that node is not rendered, **no control exists anywhere on the page**, and the queue can
never advance.

Measured state on the Shape-4 build, after approving as far as possible:

```
liveConfirmed:   10          ← queue is waiting on liveNodes[10]
liveNodes[10]:   stop_rejected [stop]
totalLive:       16
renderedCount:   14          ← stop_rejected is NOT among them
anyConfirmCtrl:  0           ← no confirm control exists in the DOM
runTestDisabled: true
hint shown:      "hover a node to confirm or reject"
counter:         "10 / 16 APPROVED"
error shown:     none
```

Two of the 16 live nodes are never drawn — **`stop_rejected`** and
**`deliver_gmail_a2_skipped`**. Both are *negative-outcome* nodes (the reject lane and the
skipped-delivery lane). The queue reaches the first of them and halts.

**Consequences.**
1. **The workflow is permanently unpublishable.** Publishing requires all steps confirmed;
   confirming requires a control that cannot exist. There is no reset, skip, or override.
2. **The UI instructs the user to do something impossible** — *"hover a node to confirm or
   reject"* — while the four remaining rendered nodes are dimmed and inert.
3. **No error is surfaced.** From the user's side the app simply stops responding to
   hovers. This is a dead end that looks like user error.
4. **The reject path is invisible even before the freeze.** The node representing "what
   happens if you reject" is the one not drawn — on an *approval gate*, whose entire
   purpose is the reject case.

**Why it is reachable.** These nodes exist because `escalation.js` injected them (see
F22). Any spec containing a `stop`/`assemble` node in a position the renderer skips will
hit this. It is not specific to approvals — approvals are just where the injected nodes
appear.

**Invariants.**
1. Every node in `liveNodes` must be rendered, or must be excluded from the approval
   queue. The queue and the renderer must draw from **one** list — they currently do not.
2. The approval queue must never be able to reach a state with no available control. If
   it does, that is a bug, and the UI must say so rather than silently idling.

**Acceptance tests (behavioral, line-independent).**
- Build a spec containing a `stop` node on a branch's reject lane. Assert
  `rendered node count === liveNodes.length`, and that after approving every node the
  counter reaches `N / N` and **Run test** enables.
- Assert the invariant directly and cheaply: for every index `i` in `liveNodes`, a
  confirm control is obtainable when `liveConfirmed === i`. Mutate: drop one node from
  the render list — the test must go red. Today it would stay green, because nothing
  compares the two lists.

**Fix applied (2026-07-19).** Two changes in `_liveLanes`, `public/index.html`:

1. **`chainFrom` walks every outgoing edge, not just the first.** It was
   `edges.find(e => e.from === cur)` in a `while` loop — a single-successor walk — so a
   *second* branch inside a lane dropped all but one of its targets. It is now a
   depth-first walk over `edges.filter(e => e.from === id)`.
2. **A shared `claimed` set makes coverage structural.** The trunk claims its nodes, each
   lane claims what it walks (so a join node renders once, in the first lane reaching it),
   and a final sweep appends anything still unclaimed to the last lane. Orphans are
   appended rather than given their own lane, because lane count drives `_liveFanout` and
   a new lane would draw a branch arrow implying a routing relationship that doesn't exist.

**Verified, including the mutation.** Against the real 16-node stuck spec: the fix renders
**16/16, zero orphans**. Reverting `chainFrom` to the original single-edge walk and removing
the sweep reproduces **exactly 14 rendered, 2 invisible** — the precise number observed in
the UI. So the check is load-bearing and the diagnosis is confirmed, not assumed. In the
live browser after the fix: `renderedCount: 16`, `confirmCtrls: 1` (was `0`), and approval
ran to **16 / 16 APPROVED**, unblocking **Run test**.

**Not fixed, and deliberately out of scope — see F23.** The nodes are now *visible and
approvable*, but a second branch still does not *fan out*. That is a layout feature, not a
one-line bug, and it was left for a deliberate decision rather than improvised here.

### F22 — 🔴 A second, unrequested approval gate is injected in front of the send

**Severity: BLOCKS.** User-reachable, changes the workflow's real-world behaviour, and the
user is never told. A person who asked to approve once will be asked to approve twice.

**What is true.** The user asked for **one** approval. The built spec contains **two
`human` nodes and two `branch` gates in series**:

```
… → deliver_slack_a1 → approve_reply[human] → route_approval[branch]
                                                 ├→ stop_rejected[stop]
                                                 └→ format_email_reply[llm:rewrite]
                                                      → ask_deliver_gmail_a2[human]        ← injected
                                                        → gate_deliver_gmail_a2[branch]    ← injected
                                                            ├→ deliver_gmail_a2[deliver]
                                                            └→ deliver_gmail_a2_skipped[assemble]  ← injected
```

The `ask_` / `gate_` / `_skipped` naming, derived mechanically from the target node id
(`deliver_gmail_a2`), is the signature of **`escalation.js` materialising a
`CONDITIONAL_UNPROVEN` gap** — the documented behaviour whereby an unprovable conditional
assertion is escalated into a real `human` gate in front of the step.

**Why this is the F17 root cause again, in a third costume.** The contract's delivery
assertion is conditional (`when: approved`). The sample drawn from the live inbox is a
Stripe newsletter, which classifies `not_support` and never reaches the approval path, so
the assertion is **not exercised** — and the system, lacking a `not_exercised` verdict,
resolves it pessimistically as *unprovable* and escalates. One missing concept, three
symptoms:

| resolution of "unexercised" | symptom |
|---|---|
| optimistic | **F3, F12, F16** — false pass |
| pessimistic (verify step) | **F17** — rebuild loop, then a misleading failure |
| pessimistic (escalation) | **F22** — a spurious second approval gate is welded into the spec |

And F22 then triggers **F21**: the injected nodes include the `_skipped` and `stop` nodes
the renderer omits, which jams the approval queue and strands the workflow. So a single
missing concept ends, four steps later, in a workflow the user can neither publish nor
delete themselves out of.

**Why it matters on its own.** Escalation is supposed to make *"accept all defaults"*
honest. Here it silently changes what the user asked for: a workflow that should ask once
now asks twice, doubling the interruption on every single support email, forever. The
plan document does not mention the second gate, and the graph does not draw its reject
lane (F21). The user would discover it in production.

**Invariants.**
1. Escalation may not inject an interactive gate the user did not request without
   **naming it in the plan** and saying why.
2. An assertion left unexercised by the chosen samples must not be treated as unprovable.
   Fix the sample coverage (F16) before escalating.
3. Two approval gates should never sit in series on one path without explicit intent —
   worth a validator rule.

**Acceptance test.** Build the Shape-4 intent. Assert the spec contains exactly one
`human` node unless the user asked for more. If escalation adds one, assert the plan
document names it and states the reason. Mutate: force `CONDITIONAL_UNPROVEN` on an
assertion whose path *was* exercised — the test must go red.

### F23 — Only the FIRST branch fans out; later branches render as a straight line

> **✅ FIXED in this session** (`public/index.html`, `_liveLanes` + the lane markup).
> Operator asked for it while the context was fresh. See "Fix applied" at the end.

**Severity: RESIDUAL, but it is a real missing feature, not a cosmetic nit.** Raised by
the operator on sight of the fixed graph: *"subsequent branches don't render in the UI.
Definitely something we need to build in."* Correct — and the F21 fix does **not** address
it.

**What is true.** `_liveLanes` fans out exactly one branch:

```js
const br = (spec?.nodes || []).find(n => n.type === 'branch' || n.type === 'decision');
```

`.find()` — the **first** branch. Its cases become lanes; `_liveFanout` draws one bezier
per lane from that single branch point. Any branch appearing *inside* a lane has no
fan-out geometry, so after the F21 fix its targets render **inline, in sequence**, within
the parent lane.

**What the user sees now.** On the Shape-4 approval workflow the tail of lane 0 reads:

```
… → Route on approval → Format reply as HTML → Ask a person → Approved?
    → Email original_sender → Not approved → Stop — rejected
```

`Email original_sender`, `Not approved` and `Stop — rejected` are **mutually exclusive
outcomes of two different branches**. Drawn end to end with connector arrows, they read as
"send the email, *then* mark not-approved, *then* stop."

**This is a real regression in meaning, and it should be stated plainly.** Before F21 the
reject path was **invisible**; after F21 it is **visible but misordered**. Visible-and-wrong
is better than invisible-and-stuck — the user can now approve, test, and publish — but it
is not correct, and a user reading this graph to check their approval logic would draw the
wrong conclusion about what happens on reject.

**Why it was not fixed here.** Recursive fan-out is a layout change, not a bug fix: lanes
are a flat list in the markup, `_liveFanout` computes geometry for one branch point, and
the scale-to-fit transform assumes a single trunk + lane block. Doing it properly means
nested lane blocks with their own fan-out geometry and re-fitting. That is a design
decision about how a nested branch should *look* (indented sub-lanes? a collapsed
"3 outcomes" affordance? a separate detail view?), and improvising it mid-test would have
been the wrong call.

**Invariant.** Every branch in the spec renders as a visible fan-out to its own cases. No
two mutually-exclusive nodes are ever drawn as sequential steps.

**Acceptance test.** Build a spec with a branch inside a branch lane (the Shape-4 approval
workflow is a ready-made fixture). Assert each branch node has its own fan-out, that the
number of visual lanes under a branch equals its distinct case targets, and that no
connector arrow joins two nodes that are targets of the *same* branch. Mutate: force the
second branch's cases into one lane — the test must go red.

**Note on ordering.** Fixing F23 will likely subsume the F21 sweep: once every branch fans
out, the depth-first walk naturally covers every node. **Keep the `claimed` sweep anyway**
— it is what makes "every node renders" true by construction rather than by the walk
happening to be exhaustive, and that is the property that stops the queue freezing.
*(Kept, as advised.)*

**Fix applied (2026-07-19).**

**A lane is now a list of ROWS, not a list of nodes.** `_liveLanes` walks linearly while
each node has one successor; the moment a node forks it closes the row on the branch node
and opens **one row per distinct target**, each labelled with that case's own words
(`↳ approve`, `↳ reject`, `↳ otherwise`). Rows stack vertically inside the lane, so
alternatives read as alternatives. It recurses, so a branch inside a branch inside a lane
also gets labelled rows.

Three details that turned out to matter:
1. **No trailing connector on the last node of a row.** A dangling `→` off the end of a row
   is precisely the false-sequence claim the fix exists to remove.
2. **Siblings before descendants.** Plain depth-first put a fork's second case *after* the
   first case's grandchildren, so `↳ reject` rendered four rows below the `↳ approve` it is
   the alternative to. Each fork now emits every sibling's first row, then their remainders,
   so the two outcomes of one decision sit together.
3. **Rows must reserve vertical space for node titles.** A node's title is absolutely
   positioned (`top:calc(100% + 8px)`) and contributes **no layout height**, so the first
   render had every sub-lane label sitting on top of the previous row's titles. Rows now
   carry `padding-bottom:40px`, matching what the trunk reserves.

**The markup change adds no fourth copy of the card block.** The card markup was already
duplicated between trunk and lane; wrapping the lane's existing `sc-for` in a rows loop
moves it one level deeper rather than repeating it. This template system has no recursion,
so a genuinely arbitrary-depth renderer would need a different approach — rows are the
honest fit for what it can express.

**What was NOT built, deliberately:** sub-fan-out **geometry**. A nested fork is expressed
by the row break and its label, not by a second set of bezier curves. `_liveFanout`
computes one branch point's geometry against the lane stack's height; nesting that properly
needs a real layout pass. Rows are honest and cheap; sub-beziers are the next increment if
the shape warrants it.

**Verified in a headed browser, both directions.**
- **Nested (the Shape-4 approval spec, 16 nodes):** renders 16/16 with rows
  `↳ approve` / `↳ reject` / `↳ approve` / `↳ otherwise`, alternatives stacked, no false
  sequence arrows. Screenshot: `tmp-g-verify/T26-nested-full.png`.
- **Regression — single branch (the 3-way triage router, 9 nodes):** renders 9/9 with the
  three fan-out lanes and their beziers exactly as before, and **no `↳` rows at all** —
  the new path correctly does nothing when nothing is nested. Screenshot:
  `tmp-g-verify/T27-single-branch-regression.png`.
- Algorithmic check against the real spec confirms `rendered === liveNodes.length` with
  zero orphans, and the tag nesting of the whole live-graph block (lines 571–699) was
  validated as balanced before loading.

**Residual introduced by this fix — worth knowing.** Stacking rows makes tall graphs: the
16-node approval workflow is now **856px** tall. `_fitLiveGraph` scales on **width only**
(`k = min(1, outerWidth / innerScrollWidth)`), so a deep workflow is not scaled down to
fit the viewport — it simply gets tall and the user scrolls. Nothing is clipped (verified:
container height tracks content, `fitsVertically: true`), but a height-aware fit or a
collapse affordance is the natural follow-up.

### F24 — 🔴 Reopening a workflow to edit it shows none of its current state — and still certifies it

**Severity: BLOCKS.** Silent, reachable every time a user returns to an existing workflow,
and it ends in a "cleared to go live" verdict rendered over a blank contract.

**What is true.** Opening a saved workflow from the sidebar loads the spec correctly but
renders essentially nothing about it. Measured on the Shape-4 draft immediately after
reopening:

```
phase:               "proposed"
spec.nodes / edges:  15 / 14      ← the spec IS loaded
liveNodes:           0
rendered graph:      0            ← no graph drawn at all
outcome.statement:   (empty)
outcome.assertions:  0            ← contract gone
THE DEAL panel:      blank
Run test:            ENABLED
```

The user is shown a workflow title, an empty contract, no graph, and an enabled **Run
test**. Running it then returns *"Contract kept … every promise held — it's cleared to go
live"* over that blank contract (see F12's second reproduction).

**Two distinct causes, both already documented — this is where they surface together.**
1. **The contract is empty because it was never persisted** (**F11**): `outcome` is NULL on
   every stored workflow, so re-hydrating from the server cannot restore it.
2. **The graph is empty because `liveNodes` is build-session state**, not derived from the
   spec on open. There is a rebuild path for it (`slice.liveNodes` is reconstructed from
   `spec.nodes` when a persisted slice lacks it), but it is not exercised on this route —
   the draft opens with `liveNodes: []` despite a 15-node spec sitting in state.

**Why it matters beyond cosmetics.** This is the *edit* entry point — the surface a user
returns to in order to check or change a live automation. It shows them nothing to check,
then offers a green verdict on it. A user cannot review what they cannot see, and the
system's confident "contract kept" actively discourages them from looking harder.

**Invariants.**
1. Opening an existing workflow must render its current graph, derived from the spec.
2. The contract shown must be the stored contract. If none is stored, the panel must say
   so — **not render blank and then certify it**.
3. No verdict may be offered over an empty contract (F12 invariant 1b).

**Acceptance test (behavioral, line-independent).** Publish a workflow, navigate away,
reopen it from the sidebar. Assert the rendered node count equals `spec.nodes.length`
(+ trigger), and that the contract panel shows the stored statement and assertions. Then
assert that if `outcome` is absent, the panel reports "no contract recorded" and **Run
test** does not produce a "kept" verdict. Mutate: blank the statement on a workflow that
has one — the test must go red.

**Fix ordering note.** F11 is a prerequisite: until the contract is persisted, there is
nothing for this view to show, and any fix here would only be re-rendering an absence.

### F25 — 🔴 A run that pauses at an approval gate is unanswerable: no record, no token, nothing to approve

**Severity: BLOCKS.** Silent, and it breaks the approval feature at run time. A real person
is DM'd asking to approve something, and there is no way for them to answer.

**What is true.** Driving the published Shape-4 workflow with a support-shaped email
reached the gate correctly and paused:

```
run.step   extract_email
run.step   classify_support
run.step   route_support
run.step   draft_reply
run.step   compose_dm
run.step   deliver_slack_a1        ← a real Slack DM was sent, asking for approval
run.paused approve_reply           ← gate fired correctly
```

**The pause left nothing behind.** Immediately afterwards:

| where an answer could come from | state |
|---|---|
| `workflow_runs` | **no row** — 6 runs total, `awaiting_human = 0`, no `test-%` id |
| `approvals/approval_tokens` | **empty table** — no token issued |
| Atlas Inbox UI | shows *"Workflow deliveries and outputs"* — a **deliveries** feed, not an approvals queue. No pending item. |

So the run asked a human a question over Slack and then evaporated. Nobody can approve or
reject it; the drafted reply is stranded; the run is neither completed, failed, nor
awaiting.

**Scope — read this before acting.** I drove `POST /workflows/run` (the same endpoint the
builder's **Run test** uses; its `runId` came back `test-…`). Test runs are deliberately
not persisted and not counted, which is correct for ordinary workflows — **but a workflow
containing a `human` node is not an ordinary workflow.** Pausing is a durable state by
definition, so "don't persist test runs" and "pause for a human" are in direct conflict,
and the conflict resolves silently in favour of losing the run.

**What I did NOT verify, and you must:** whether a **scheduler-driven** (non-test) run of
the same workflow persists correctly and appears somewhere answerable. The store has
`pauseRun` / `listAwaitingHuman` / `markRunResumed`, so the durable path plausibly works.
**Do not conclude the approval feature is broken end to end from this finding** — conclude
that the *test* path strands pauses, and go check the scheduled path.

**This is also why "does reject block the send" is STILL unproven.** The gate fires; the
answer cannot be given; so the branch after it was never exercised. That remains the single
most important untested behaviour in the product.

**Invariants.**
1. If a run can pause, its pause must be durable and answerable — or the run must refuse
   to start. A pause that cannot be answered is worse than a failure, because a person was
   asked and is now waiting.
2. **Run test** on a spec containing a `human` node must either (a) persist the pause and
   surface it in an approvals queue, or (b) state up front that the gate will be simulated
   / cannot be answered — before it DMs a real person.

**Acceptance test.** Run a workflow containing a `human` node through the test path with
input that reaches the gate. Assert that either an answerable artifact exists (a durable
run row in `awaiting_human` **and** a queue entry or token), or that no approval
notification was sent to any human. Mutate: drop the persistence — the test must go red.

### F26 — 🔴 Delivered messages contain unsubstituted templates and an error sentinel as their body

**Severity: BLOCKS.** These are *delivered outputs* — the product's work product — and they
are visibly broken. Pre-existing (4 days old, from the operator's own earlier runs), not
produced by this session.

**What is true.** The Atlas Inbox contains delivered messages whose **titles are raw
templates that were never substituted**:

```
[P1/P2/P3] Support email from {sender} — {subject}     (×6)
P1 / P2 / P3 — <email subject>                          (×3)
```

Opening one, the **body** is:

```
ERROR: required data not found
```

That string is the guard-clause sentinel the converger writes into content nodes ("if the
provided data is empty or missing, output EXACTLY: ERROR: required data not found"). So
these deliveries carry a placeholder title over an error sentinel body, and were delivered
and stored as normal successful output.

**Why it matters.** Two independent guards should have caught this and neither did:
`output-validator.js` inspects delivered output for an empty body or a leaked template, and
`outcome-oracle.js` has a `CONTENT_ERROR_SENTINEL` check for exactly this string. **This is
consistent with the recorded defect that `run.output` was the last delivery's *receipt*
rather than the work product** — those checks were reading the wrong thing, so `EMPTY_BODY`
and the sentinel check could never fire correctly. That was fixed by moving `deliver` into
`CONTROL_TYPES`; these messages predate the fix, so **verify against a fresh run before
concluding the guards are still broken.**

**Invariants.**
1. A delivery whose body is the error sentinel must fail the run, not be delivered.
2. A delivery whose title or body still contains `{…}` / `<…>` placeholder syntax must fail
   validation — an unsubstituted template is a template that found no value.

**Acceptance test.** Force a content node to emit the sentinel (feed it an empty body).
Assert the run fails and nothing is delivered. Separately, assert a delivery whose subject
contains an unresolved `{placeholder}` is rejected. Mutate each guard — both must go red.

### F27 — UI note (operator): the live dashboard should render the real workflow shape

**Severity: RESIDUAL — a design request, recorded verbatim so it is not lost.** Raised by
the operator: *"on the live dashboard, I say we render the real workflow node shape instead
of the way it looks now."*

**What is true today.** The console/live-dashboard renders the workflow as a flat
left-to-right strip of labelled pills:

```
⏱ SCHEDULE → λ GMAIL—SEARCH → Σ SUMMARIZE → # DELIVER
```

That is fine for a linear workflow and **actively wrong for a branching one**: it shows no
lanes, no fan-out, and no reject path, so a 3-way router and a linear digest look
structurally identical on the dashboard a user checks daily.

**What is wanted.** The dashboard should use the **same node/graph rendering as the
builder** — real shape, real branches, real lanes — so the live view of a workflow matches
the thing the user approved.

**Dependency — F23 first. ✅ NOW CLEARED.** The builder's renderer used to fan out only the
*first* branch, so adopting it on the dashboard would have reproduced that limitation on a
second surface. **F23 was fixed in this session**, so the builder's renderer now shows every
branch's alternatives as labelled rows. This note is therefore **unblocked and ready to
pick up.**

**Sharing the renderer is the right end state** — one renderer means the dashboard and the
builder cannot disagree about a workflow's shape, which is the "one oracle, not two"
doctrine applied to layout. Two practical notes for whoever does it:
- The live-graph renderer currently reads build-session state (`liveNodes`, `liveConfirmed`,
  `awaitingGraphApproval`) that the dashboard has no equivalent of. It needs a read-only
  mode driven from `spec.nodes` / `spec.edges` alone, with the approval affordances off.
  **F24 wants exactly the same thing** (the edit view renders no graph despite holding a
  15-node spec), so build the spec-driven mode once and both surfaces get it.
- Mind the height residual recorded under F23: rows stack, so a deep workflow gets tall and
  `_fitLiveGraph` scales on width only. The dashboard has less vertical room than the chat
  column, so it will hit this sooner.

### F28 — 🔴 A multi-tool chat turn returns unparsed prose, truncating the message and stranding the turn

**Severity: BLOCKS.** Silent, reachable on the main build path whenever schema discovery
runs, and it leaves the user with a half-sentence and no control to press.

**What is true.** Building Shape 6 required two Airtable tool calls. The turn came back:

```
"kind":"chat.tool.ok",  tool:"airtable_list_bases"
"kind":"chat.tool.ok",  tool:"airtable_describe_base"
"kind":"chat.reply",    turns:3, readyToBuild:false, parsed:false
"path":"/api/builder/chat", status:200, ms:12480
```

`parsed:false` — the model returned prose instead of the JSON envelope. The user-visible
result: the message **stopped mid-sentence** (`"Notes → subject line / Source →"`), no
**Build it** button appeared, no error was shown, and streaming was over
(`grew: 0` across 6s). The conversation looked dead.

**This is the documented `parsed:false` gotcha recurring, and the mitigation is
structurally incomplete.** `builder.js` appends a JSON-format reminder to the last **user**
message when tools are active — and the comment records exactly why that position was
chosen: *"the most salient position immediately before the model's turn."*

**The tool loop destroys that property.** The reminder is applied **once, before** the
loop. Each tool round then pushes an `AIMessage` + tool result onto `msgArray`, so by the
final text turn the reminder sits four messages back and the model is generating right
after a tool result. It holds for 0–1 tool rounds and degrades with every additional one.
Two tool calls (`turns: 3`) was enough.

**This will get worse, not better.** Schema-aware connectors (Increment F) exist to make
the model call `*_list_bases` then `*_describe_base` — i.e. the feature that makes writes
usable is the same feature that reliably pushes the turn past one tool round.

**Recovery.** Sending any further message recovers — the next turn re-applies the reminder
to a fresh user message and works. So it strands a **turn**, not a session. But nothing
tells the user that; the rational response to a dead half-sentence is to reload, and a
reload loses the build session (see F2/F24).

**Invariants.**
1. A chat turn that fails to parse must surface as a recoverable error with a retry
   affordance — never as a truncated message with no controls.
2. The format instruction must be re-asserted **on every model turn**, not once before a
   loop that appends messages after it. A reminder whose effectiveness depends on adjacency
   must be re-established whenever something is appended between it and the model.

**Acceptance test.** Drive a chat turn that requires ≥2 tool calls (e.g. "use my Airtable
base, look up the table yourself"). Assert the final reply parses and a build control is
offered. Mutate: move the reminder back to pre-loop-only — the test must go red.
**Note this test is only meaningful with ≥2 tool rounds**; a single-tool test passes today
and is why this shipped.

### F29 — 🔴 A correct Airtable write is reported as missing: the contract names the table, the node carries its resolved id

> **✅ FIXED in this session** (`outcome-oracle.js` `satisfiesAssertion`, plus a corrected
> false comment in `elicitation-graph.js`). See "Fix applied" at the end.

**Severity: BLOCKS.** Silent and inverted — the system tells the user a step they *do*
have is absent, and offers to add a duplicate.

**What is true.** Shape 6 built correctly. The `foreach` contains a well-formed write with
fully resolved ids and real per-column mapping:

```json
{ "id":"create_airtable_record", "type":"deliver", "config":{
    "channel":"airtable_create_record",
    "baseId":"appiJz0lZ1DJtVrAU", "tableId":"tblVbidmBZuBt1Tkf",
    "fields":{ "Name":"{{extract_and_summarize.sender_name}}", … } } }
```

Yet the gap review reported:

> *"The outcome promises `airtable:Sheet1` (record_exists), but **no step in this workflow
> does that** — the request would be silently dropped."*

**The write existed from checkpoint 6; the gap fired at checkpoints 13–16.** It is false.

**Cause — isolated exactly.** `nodeEffect` **does** recurse into `foreach.config.steps`
(the Increment F fix is intact) and returns
`{kind:'record_exists', connectors:Set{'airtable'}, locators:['tblVbidmBZuBt1Tkf','appiJz0lZ1DJtVrAU'], fields:[…]}`.
Matching the assertion against that node:

| assertion target | `satisfiesAssertion` |
|---|---|
| `airtable:Sheet1` — the **name** the user, the plan and the contract all use | **false** |
| `airtable:tblVbidmBZuBt1Tkf` — the **resolved table id** | true |
| `airtable:appiJz0lZ1DJtVrAU` — the base id | true |
| `airtable` — connector only | true |

Kind matches, connector matches, `missingFields` is empty. **The sole failure is the
locator**: the contract says `Sheet1`, the node carries `tbl…`.

**This is Increment F's own destination resolution biting the contract.** F resolves the
human table name to an id in the node config — correctly, that is the feature. F's round-2
fix then restated the contract in the table's own words **for COLUMNS** (the rename map,
`Deal Size` vs `Budget`). **It did not do the same for the TABLE LOCATOR.** Same defect,
one level up.

**Why it is worse than a false warning — tested, and NOT the way I first predicted.**

> **Correction (third in this document).** I predicted that accepting the suggested
> resolution would add a **second** write, giving 2N writes per fire inside the loop. **I
> tested it and that did not happen.** Clicking "Use your suggestions" left exactly one
> Airtable write in the loop — the converger correctly declined to add a step that already
> existed. My prediction was wrong and the duplication claim is retracted.

What actually happens is a **hard, unresolvable dead end**:

1. Accepting the suggestion is a **no-op** — nothing is added (correct) but nothing is
   reconciled either. The assertion target stays `airtable:Sheet1` across every checkpoint
   (12 → 16 → 20); it is never restated in the id form the checker compares.
2. The gap **persists** and is promoted to a publish blocker: *"Before this can go live: …
   no step in this workflow does that."*
3. Running the test does not help, because **the run is rejected before the engine starts**:
   `"kind":"run.start" … "kind":"run.invalid","codes":["UNSATISFIED_ASSERTION"]`.
4. **No "Go live" control is rendered at all.** The workflow cannot be published, cannot be
   run, and the one offered remedy does nothing.

So the user has a correct, fully-resolved workflow that the product refuses to run or
publish, with no path forward through the UI. This is `complete ⇒ publishable` broken
again (the Increment C blocker) via the locator.

**The failure is also misreported as a runtime break.** The panel says *"Break found — one
step failed — review the break below"* and the chat explains *"there's no step in the
workflow that actually connects to Airtable, so the whole thing broke down."* **No step
ran.** The event log shows `run.invalid` with zero `run.step` entries — this is a
validation rejection, not an execution failure, and the narrated cause is fabricated. A
user would go looking for a broken Airtable step that is both present and correct.

**Zero examples produces OPPOSITE verdicts across shapes — extend F12 with this.** Here the
panel reads *"Contract not met. We ran **0 real examples**… **0 of 0** promises fell
short"*, while Shapes 1 and 4 read *"Contract kept. We ran 0 real examples… every promise
held — it's cleared to go live."* Same evidence (none), opposite conclusions, plus the
nonsensical "0 of 0 fell short". Whatever fix lands for F12's "zero examples is not a pass"
must also make zero examples not a *fail* — the honest verdict is **not verified** in both
directions.

**Invariants.**
1. When a destination is resolved from a human name to an id, the contract must be
   restated in whichever form the checker compares — locator included, not only columns.
2. An assertion must not be reported unsatisfied when a node satisfying it exists under a
   different-but-equivalent identifier for the same destination.
3. A gap's suggested resolution must not be capable of duplicating an existing step.

**Acceptance test.** Build a write-only workflow against a real connector, letting the
converger resolve the destination by name. Assert `checkOutcome` reports the assertion
**satisfied**, and that no "no step does that" gap is raised. Mutate: strip the
name↔id reconciliation — the test must go red. Extend with the loop case: assert accepting
every suggested gap resolution never produces two write steps to the same destination.

**Fix applied (2026-07-19).**

**An opaque provider id is UNDECIDABLE here, not a mismatch.** `satisfiesAssertion`'s
locator comparison now skips a locator that is a provider id, exactly as it already skips
a template — the line above it reads *"resolved at run time — undecidable here, so not a
mismatch"*, and an id is undecidable for the same reason. Only a call to Airtable can say
whether `tblVbidmBZuBt1Tkf` is `Sheet1`; comparing them as strings answers a question this
function cannot answer, and it answered "mismatch", the one answer that is never safe.

Deliberately narrow — `/^(app|tbl|rec|fld|viw)[A-Za-z0-9]{14}$/`, the documented Airtable
prefixes with their exact body length. `Sheet1`, `#general`, `ops@acme.com` are untouched,
so a genuinely wrong human-named destination still fails. **Kind, connector and fields
remain fully enforced.**

**Why the fix is in the oracle, not the converger** (where the recorded precedent lives):
`fillDestination` writes the table's **name** into `config.tableId` (its callers pass
`table.name`), so a converger-resolved destination already matches a name-based assertion.
The mismatch arises when the **model** writes a raw provider id it learned from
`airtable_describe_base` — on a spec `fillDestination` never touches. A converger-side fix
would not have run on the failing build, and would not repair specs already saved.

**Also corrected: the false comment that caused this.** `elicitation-graph.js` asserted
*"airtable/base assertions key on kind, not the id, so they need no rewrite here."* That is
false and is now documented as false, with the verified counter-evidence, so the next
reader does not re-derive the same wrong conclusion.

**Verified, including the mutation and the negative cases.**

| check | result |
|---|---|
| `airtable:Sheet1` + fields vs the real `foreach` node | **true** (was false) |
| `airtable:tblVbidmBZuBt1Tkf` | true |
| `airtable` (connector only) | true |
| **NEGATIVE** `slack:#general` | false |
| **NEGATIVE** `gmail:ops@acme.com` | false |
| **field guard** `missingFields(fields:['Name','Budget'])` | `["Budget"]` — intact |

Mutation: deleting the `isOpaqueId` line flips the real case back to **false**; restoring it
returns **true**, and the field guard is unaffected in both states — confirming the change
is narrow and load-bearing. `node --test "tests/workflows/*.test.js"` → **502 pass, 0 fail**.

**End-to-end, in the running app.** Before: `run.start → run.invalid ["UNSATISFIED_ASSERTION"]`
— the engine never executed. After (server restarted onto the fix):

```
run.start  nodes:["connector-action","foreach"]
run.step   search_emails
run.step   process_emails
run.ok     steps:2, ms:276
```

The engine now runs the `foreach`, and the test panel evaluates **3 real examples** where it
previously reported `0 of 0`.

**The workflow still does not publish — correctly, and for a DIFFERENT reason.** All three
examples now fail with *"This one fell short — nothing reached airtable:Sheet1."* That is
**true**: the examples describe unread emails ("Three unread emails from last 24 hours") but
the live inbox has none, so the loop iterates zero times and no record is written. **This is
F3 — an example's `given` cannot reach a connector read** — not F29. The system has gone
from failing *falsely for the wrong reason* to failing *honestly for the right one*, which
is the correct end state for this fix and leaves F3 as the next blocker.

**Still unverified as a result:** `foreach` under real load — N-writes-per-fire, sub-step
idempotency, `{{item}}` binding. The loop now executes but iterated **zero** times. Getting
this data needs either F3 fixed or real unread mail in the connected inbox.

**Unverified, do not carry as fact.** Calling `checkOutcome(spec)` directly on this draft
returned `{satisfied:{}, unsatisfied:[], malformed:[]}` — zero assertions seen — despite
`spec.outcome.assertions.length === 1`. I could not establish the correct calling
convention within this session (I got `satisfiesAssertion`'s argument order wrong once
already and corrected it). **This may simply be my call being wrong.** Worth a look, but do
not report it as a defect without grounding it yourself.

### F30 — 🔴 EXECUTION DEFECT: a connector write inside a `foreach` gets no credentials and fails as "not connected"

> **✅ FIXED in this session** (`src/api/server.js` — two shared helpers, applied to all
> four injectors). See "Fix applied" at the end. **This fix produced the session's first
> real `foreach` execution data.**

**Severity: BLOCKS.** Destructive to the entire bulk-write shape, and its error message
actively misdirects the user. **This is the first defect in this document that lives in the
execution path rather than the build/verification path.**

**What is true.** Running the Shape-6 workflow with a query that actually returns mail:

```
run.step  search_emails                                     ← ok
error:    "process_emails: airtable: not connected —
           authorize via /connectors/airtable/oauth/start"
```

Airtable **is** connected. The Connections panel reads "Connected · healthy", and
`airtable_list_bases` + `airtable_describe_base` both succeeded minutes earlier in the same
session against the same tenant.

**Cause — the `foreach` laundering hop, this time in TOKEN INJECTION.** `injectTenantTokens`
(`src/api/server.js`) walks **top-level nodes only**, in both the guard and the map:

```js
const isAirtableNode = (n) =>
  (n?.type === 'deliver'           && AIRTABLE_ACTION_IDS.has(n?.config?.channel)) ||
  (n?.type === 'connector-action'  && AIRTABLE_ACTION_IDS.has(n?.config?.action));

for (const c of CONNECTOR_INJECTORS) {
  if (!nodes.some(c.ownsNode)) continue;                 // ← top level only
  const tok = await c.resolveToken(tenantId, deps);
  nodes = nodes.map((n) => c.ownsNode(n) ? {…inject…} : n);   // ← top level only
}
```

Shape 6's top-level nodes are `connector-action(gmail_search)` and `foreach`. The Airtable
write lives at `foreach.config.steps[1]`. So `nodes.some(isAirtableNode)` is **false**, the
injector short-circuits, no `airtableToken` is set, and the sub-step fails at run time.

**This is generic over every connector.** The loop iterates `CONNECTOR_INJECTORS`, so the
same hole applies to Airtable, Google and Slack: **no connector write inside any `foreach`
can ever receive credentials.** The canonical bulk-write pattern — the shape Increment F
exists to enable, and which its own prompt teaches ("create a record for every row") —
cannot run at all.

**The error message makes it worse.** *"not connected — authorize via
/connectors/airtable/oauth/start"* sends the user to re-authorize a connector that is
working. They will disconnect and reconnect, the symptom will persist, and nothing in the
message points at the loop.

**Fifth occurrence of one lesson.** `CLAUDE.md` already records this exact hop four times:
the validator learned to recurse into `foreach` steps (F #3), the outcome oracle learned it
(F #4), `isWriteNode` learned it (D #4), and `CONTROL_SUBSTEP_TYPES` needed the same for
`decision` (E #1). Its own words: *"A check on a node's config is a check on EVERY node's
config, wherever the node lives."* **The token injector never learned it.** Credential
injection is not a check, which is presumably why it was never swept up — but it walks the
node list exactly like the checks do, and it has the same blind spot.

**Invariants.**
1. Any traversal of `spec.nodes` that decides something per-node must consider sub-steps
   inside a `foreach`. This should be a shared helper, not a rule each site re-implements —
   five sites have now independently gotten it wrong.
2. A capability that cannot obtain credentials must not report "not connected" when the
   connector *is* connected. The message must distinguish "no grant for this tenant" from
   "a grant exists but was not injected for this node".

**Acceptance test (behavioral, line-independent).** Build a workflow whose only connector
write is inside a `foreach`, with the connector connected. Run it against input producing
≥1 iteration. Assert the write **succeeds**. Mutate: remove `foreach` recursion from the
injector — the test must go red. Repeat for a second connector (Google) to pin that the fix
is in the shared traversal, not special-cased to Airtable.

**Note on discovery.** This was only reachable after fixing F29 (which blocked the run at
validation) *and* widening the query so the loop had rows — the connected inbox had **zero**
messages in the workflow's own `newer_than:1d` window. Two defects and an empty-inbox
coincidence were stacked in front of it, which is why four earlier shapes all reported the
execution layer as clean.

**Fix applied (2026-07-19).** Two helpers, `someNodeDeep` / `mapNodesDeep`, that traverse a
node list **including `foreach` sub-steps** (recursively), now used by **all four**
injectors. `mapNodesDeep` applies the function to the `foreach` node itself first (a no-op —
it is never a connector node) and then maps its steps, so nothing at the top level changes
behaviour.

**One pair of helpers, not four private patches** — deliberately. Five sites have now
independently gotten this traversal wrong; a shared helper is the only version of the fix
that stops the sixth.

**Verified.**

| check | result |
|---|---|
| detects a connector node inside a `foreach` | true (was false) |
| detects one at top level (no regression) | true |
| no false positive on an unrelated node | false |
| injects the token **into the foreach sub-step** | `TOK` |
| top-level injection still works | `TOK` |
| the `foreach` node itself is untouched | `undefined` |
| a non-matching sub-step is untouched | `undefined` |

Suites: `tests/workflows/*` **502 pass / 0 fail**, `tests/approvals/*` **58 pass / 0 fail**.

**End to end, in the running app.** Same workflow, same tenant, before and after:

```
BEFORE  run.failed  failedStep:1  error:"process_emails: airtable: not connected …"
AFTER   run.start → run.step search_emails → run.step process_emails → run.ok (13.3s)
```

Returned output:

```json
{"count":3,"total":3,"truncated":false,"skipped":0,
 "results":[{"id":"recRvM5FZ32Ky9cPN","fields":{
   "Name":"Charles Crepps","Email":"charles@agntic.co",
   "Notes":"Your Morning Briefing",
   "Message":"The email is a self-sent daily briefing covering…"}}, …]}
```

**THE FIRST REAL `foreach` EXECUTION EVIDENCE IN THIS DOCUMENT.** 3 iterations, **3 real
Airtable records created** (real `rec…` ids returned by the API), correct per-column
mapping, and distinct per-item values — so `{{item}}` binding, the sub-step LLM, and the
sub-step write all work under load. `skipped: 0` is consistent with the spec declaring no
idempotency key (the converger's own reasoning recorded that choice).

**Still not exercised, even now:** sub-step **idempotency** (no key was declared, so the
dedupe path never ran) and **failure/retry inside a loop** (all 3 iterations succeeded).
Those remain the two untested execution behaviours.

### F31 — The `decision_review` UI renders as prose with raw field names, not the specified editable table

**Severity: RESIDUAL** (the table is correct and reviewable; only the review surface is
weaker than designed).

**What is true.** Reviewing the decision table renders a numbered prose list:

```
1. when customer_tier enterprise, reports_outage yes → priority = P1
2. when customer_tier enterprise, reports_outage no  → priority = P2
3. when customer_tier smb,        reports_outage yes → priority = P2
4. when customer_tier -,          reports_outage -   → priority = P3
```

…followed by *"Does that match how you actually decide?"* and a single **Looks right**
button. Screenshot: `tmp-g-verify/T28-decision-review.png`.

Increment E specifies something quite different: *"a TABLE, not prose: collapsed to one
sentence by default, expanding to a grid whose cells are **dropdowns over the declared enum
values**… plus the hit policy as a plain-language radio (never the DMN letter)."*

**Three gaps against that spec:**
1. **No grid, no dropdowns.** The values are the very enums (`enterprise|smb|free`,
   `yes|no`, `P1|P2|P3`) that would populate them.
2. **Raw internal identifiers are shown to the user** — `customer_tier`, `reports_outage`,
   `priority` — rather than plain language.
3. **The DMN `-` marker is exposed raw.** *"when customer_tier -, reports_outage -"* is the
   catch-all row, and it is unreadable to a non-technical operator — the stated target user.
   The hit policy is not surfaced at all.

There is also **no way to edit** — only accept wholesale or describe changes in prose. E's
own residual notes the UI "edits cells, `then`s and the hit policy — it cannot ADD or DELETE
a rule", which implies an editing surface exists; none is reachable here.

**Why it matters beyond polish.** E's §13 argument is that the completeness proof and the
multiple-choice UI are *the same asset*: closing the domain (`LLM_INPUT_NOT_ENUM`) is what
makes dropdowns renderable, and the dropdowns are what make the proof affordable to review.
Half of that is built. The user is asked to ratify a correctness-critical routing table by
reading generated pseudo-code — which is exactly the review this design set out to avoid.

**Invariant.** A decision table presented for human ratification must be reviewable and
editable in the user's own vocabulary — enum values as choices, the catch-all as plain
language ("anything else"), the hit policy as a sentence.

**Acceptance test.** Build a workflow with a 2-input decision table. Assert the review
surface exposes each rule's cells as controls constrained to the declared enum values, that
no raw `-` marker or internal key name appears in user-visible text, and that the hit policy
is described in words. Mutate: swap the grid for the prose renderer — the test must go red.

### F32 — 🔴 A `decision` before the `branch` collapses the whole graph to a flat line

> **✅ FIXED in this session** (`public/index.html` — one shared `_laneSourceOf`, applied
> to three call sites). Spotted by the operator on sight: *"Notice the node rendering in
> the UI. Not right."*

**Severity: BLOCKS** by the calibration — user-reachable on the canonical decision shape,
and **silent**: the graph does not error, it draws a plausible-looking flat pipeline that
misrepresents the workflow's actual structure.

**What is true.** Shape 5 (`extract → decision → branch → {P1 lane | silent lane}`)
rendered as a **single flat row with no lanes at all**:

```
A new email… → Extract email… → Determine priority → Route by priority → Format P1… → End silently  Post to #agntic-x…
   TRIGGER        LLM·EXTRACT       DECISION            BRANCH              LLM          STOP        DELIVER
```

The `BRANCH` node is drawn but does not fan out; the P1 outcome and the silent stop are
strung together in sequence, with "End silently" and "Post to…" overlapping. A user reading
this graph would conclude the workflow posts to Slack on **every** email — the exact
opposite of what it does.

**Cause.** Three sites located the lane source as *the first `branch` **or** `decision`*,
then read `config.cases` off it:

```js
const br = (spec?.nodes || []).find(n => n.type === 'branch' || n.type === 'decision');
const cases = (br.config && br.config.cases) || [];
if (!cases.length) return null;          // ← bail out ⇒ no lanes ⇒ flat graph
```

**A `decision` has no `cases`.** Its shape is `inputs / output / hitPolicy / rules`. On the
canonical shape the decision comes **first**, so `find` returned it, `cases` was empty, and
lane rendering bailed — taking the real branch's lanes with it. A decision produces a
*value*; the branch downstream of it is what routes.

**Three call sites, one rule.** `_liveTrunkOf` and `_liveLanes` (the graph) and
`_stepShape` (the panel's "N steps · M paths"). `_stepShape` additionally cut the step
count short at the decision and reported **0 paths** for a workflow with two visible lanes
— so the panel and the graph disagreed about the same spec, each wrong in its own way.

**Invariant.** Lanes come from the node that has `cases` — the `branch`. A `decision` is
never a lane source. All surfaces that locate the branching point must use one shared
definition.

**Acceptance test.** Build `extract → decision → branch` (Shape 5 is the fixture). Assert
the graph renders one lane per distinct branch target with its label, that the node count
in lanes + trunk equals `liveNodes.length`, and that the panel's path count equals the
number of distinct targets. Mutate: restore `find(branch || decision)` — the test must go
red.

**Fix applied.** One helper, used by all three:
`_laneSourceOf(nodes) → first node with type 'branch' AND non-empty config.cases`.

**Verified, with the mutation captured explicitly** (8/8 against the real Shape-5 spec):

| check | result |
|---|---|
| new: lane source is `route_priority` (the branch) | ✓ |
| **old: picked `priority_decision` (the decision)** | ✓ reproduced |
| **old: yielded 0 cases ⇒ flat graph** | ✓ reproduced |
| new: yields 4 cases, 2 distinct lane targets | ✓ |
| Shape 3 (branch only, no decision) unchanged | ✓ |
| Shape 1 (no branch) still returns null | ✓ |
| a `branch` with empty `cases` is not a source | ✓ |

**Rendered result:** two lanes with proper bezier fan-out, labelled *"Priority is P1"* and
*"Priority is P2 or P3"* — the second label correctly **combining** the P2/P3/`*` cases that
dedupe onto one target. Screenshot: `tmp-g-verify/T30-shape5-lanes-fixed.png` (before:
`T29-shape5-graph.png`).

**Note:** this is independent of F23. F23 was "later branches don't fan out"; F32 is "a
decision anywhere before the branch disables fan-out entirely". Both were latent in the
same three lookups.

---

## Verified working

Recording what was driven and found **correct**, so the next agent does not re-test it or
mistake silence for a gap.

- **✅ The scheduler fires accurately and does not double-fire.** With the workflow live
  on `*/2 * * * *`, observed scheduled (non-test) runs at **14:54:54.481Z** and
  **14:56:54.482Z** — a 120.001s interval, exactly one run per window, no duplicates and
  no drift. Console independently showed "4 RUNS · 0 ERRORS · 100% success". Sub-daily
  elapsed-time dedupe behaves as designed.
- **✅ Editing a live workflow does not mutate production.** While the draft carried the
  new `*/2` cron, the live row remained `0 8 * * 1-5` / `active` until republish was
  explicitly confirmed. The draft/live boundary holds.
- **✅ Publish writes `status:'active'`**, so the scheduler picks the workflow up
  immediately — no manual activation step needed.
- **✅ Sequential node approval works**, advancing 0/4 → 4/4 one node at a time and
  unlocking **Run test** only at completion.
- **✅ The plan document, go-live review screen, and live console are clear, well
  structured, and accurate about the workflow's shape.** The "WHAT YOUR TEAM SEES" Slack
  preview showed the real posted message.
- **✅ FAN-OUT IS CORRECT — the asymmetric receipt defect does NOT reproduce.** Shape 2
  ("send the SAME note to Slack **and** the inbox") produced a true fan-out: two edges from
  `generate_note` to `deliver_slack_a1` and `deliver_inbox_a2`, not a chain. Both fired on
  all 3 examples. **Destination #2 received the actual note**, verified by reading the inbox
  store directly:

  > *"Saturday mornings are for the ones who show up anyway, and here you are — that already
  > says everything about who this team is…"*

  — not `{"delivered":true,"ts":…}`. The recorded defect (the second `deliver` shipping the
  first one's **receipt**, fixed by moving `deliver` into `CONTROL_TYPES`) is **closed and
  stays closed**. This was checked the way the recorded lesson demands: by asserting what
  each destination *received*, not that a delivery *ran*.

- **✅✅ THE DECISION TABLE SHAPE IS THE CLEANEST RESULT IN THIS DOCUMENT — including the
  first genuine LANE COVERAGE.** From plain English ("enterprise + outage is P1…"), the
  converger produced a textbook DMN table: both inputs `type:'enum'` with closed value sets,
  `output` enum `P1|P2|P3`, `hitPolicy:'FIRST'`, an exhaustive `{"customer_tier":"-",
  "reports_outage":"-"} → P3` catch-all row, and `from` references to the extract node's
  declared fields. The branch routes on `priority_decision.output` with every case a member
  of the output enum plus the mandatory `*`. **Every moat invariant satisfied, unprompted.**

  At run time, 4 examples produced **4 different decisions** and the engine routed each
  correctly — verified in the event log:

  ```
  4 × extract_email   4 × priority_decision   4 × route_priority
  3 × stop_silent        ← the P2 / P2 / P3 lanes
  1 × format_alert   1 × deliver_slack_a1     ← the P1 lane, exactly once
  ```

  **This is the first time examples covered every lane of a branch** (contrast F16, where a
  3-lane router was certified on one sample that took the do-nothing lane).

- **✅ …and it isolates F3's mechanism by contrast.** Shape 5's examples work because its
  trigger carries a payload **and its entry step consumes that payload** (`extract_email`
  reads the seeded event). Shape 1's failed because its entry step was a **connector read**
  that re-fetches live data, so no seeded `given` could reach it. Same example machinery,
  opposite outcomes, and the difference is exactly the mechanism F3 describes — treat this
  pair as the regression fixture when fixing F3.

- **✅ `foreach` + a write is CONSTRUCTED correctly, and the oracle's loop recursion is
  intact.** Shape 6 produced `search_emails → foreach(process_emails)` whose steps are
  `extract_and_summarize (llm)` + `create_airtable_record (deliver)` with **fully resolved**
  `baseId`/`tableId` and real per-column templates (`{{extract_and_summarize.sender_name}}`
  → `Name`, etc.) — exactly the shape Increment F was built to produce, from a plain-English
  request. `nodeEffect` correctly recurses into `foreach.config.steps` and returns
  `record_exists` with connector `airtable` — the Increment F loop fix is intact and
  verified by direct call. **The loop's run-time behaviour is still unverified** (F29 blocks
  the run before the engine starts), so N-writes-per-fire, sub-step idempotency and
  `{{item}}` binding remain untested.
- **✅ Schema-aware destination resolution works end to end.** Asked for "my Airtable base",
  it listed the tenant's two **real** bases, refused to guess between them (correctly
  overriding "don't ask me questions" — the one thing it genuinely cannot know), then read
  the actual table and its real columns and proposed a field mapping. The plan card carries
  a **FROM YOUR KNOWLEDGE** provenance line citing the live schema.
- **✅ THE APPROVAL GATE FIRES CORRECTLY AT RUN TIME.** This is the most important positive
  result of the session, and it was only reachable after fixing F21. Driving the published
  Shape-4 workflow with a genuine support-shaped email produced exactly the right trace:
  `extract_email → classify_support → route_support → draft_reply → compose_dm →
  deliver_slack_a1 → **run.paused @ approve_reply**`. The classifier correctly routed a real
  support email down the support lane, the draft was composed, the DM went out, and the run
  **paused for a human instead of sending**. The engine-side gate works.
  **Caveat: it cannot be answered (F25), so the branch AFTER the gate — whether reject
  actually blocks the send — remains unproven.**
- **✅ Pausing genuinely stops the scheduler.** After pausing the `*/2` workflow, run
  count held at 3 across 5.5 minutes (≈2.75 missed windows). No catch-up burst on pause,
  and none observed on the subsequent idle period.
- **✅ The branch/moat structure the converger emits is correct.** For the 3-way router
  it produced `branch.on = "classify_email.output"` (routing on a `classify` node, i.e.
  the allowlist is satisfied), every case value a member of the declared categories
  (`urgent`/`billing`/`general`), and the mandatory `*` catch-all. `LLM_INPUT_NOT_ENUM`
  and `BRANCH_CASE_NOT_IN_ENUM` are doing their jobs on generated specs.
- **✅ `parseEnumList` handles the string form of `categories`.** The converger emits
  `categories` as a newline-delimited **string**, not an array. I chased this as a
  possible silent moat-bypass; `parseEnumList` splits on `[\n,]` and also accepts arrays,
  so `closedDomainOf` resolves correctly. **Not a bug — do not "fix" it.**
- **✅ The example picker pulls real typed examples when the trigger carries a payload.**
  The email-triggered workflow was tested against a genuine message from the live inbox.
  (Its limitation is coverage, not authenticity — see F16.)
- **✅ The converger honours "build it now, don't ask me questions"** — it skipped
  elicitation, restated the plan, and proceeded.
- **✅ A `stop` lane is modelled explicitly.** "If general: do nothing" produced a real
  `stop` node and a labelled lane rather than a dangling edge.
- **✅ `_flowScheduleState` reads the trigger correctly.** The `workflows.schedule`
  column is empty while the cron lives in `triggers` JSON; due-detection reads
  `t.cron ?? t.config?.cron` from `triggers` and handles both shapes. **This is not a
  bug — do not "fix" it.** I chased it and it is correct.

---

## Coverage

What has actually been driven in a real browser so far. Nothing else should be assumed
tested.

| Workflow shape | Status |
|---|---|
| 1. Linear: trigger → llm → single deliver | **built, approved, tested** — F3–F10 |
| 2. Fan-out to two destinations | **built, tested — fan-out CORRECT; runtime proof for F3b** |
| 3. classify → branch, 3-way routing | **built, approved, tested** — F16 |
| 4. Human approval gate before a send | **built, approved 16/16, tested** (after fixing F21) — F17–F23 |
| 5. Decision table routing | **built, tested, FULL LANE COVERAGE — cleanest pass** — F31, F32 |
| 6. Write-only (no deliver node) | **built, runs, 3 real records written** (after fixing F29 + F30) — F28–F30 |
| 7. Scheduler fires when due | **verified passing** (fire cadence + pause) |

Surfaces exercised: login/landing, What's-New modal, sidebar, clean-slate canvas,
`localStorage` persistence, intake, elicitation, plan document + provenance chips,
live build graph, sequential node approval, test panel / outcome oracle, go-live review,
publish, live console, run history, SOP tab, edit-a-live-workflow, republish, pause,
scheduler firing.

**Shape 4: built on the second attempt, froze at 10/16, then completed after F21 was
fixed.** Attempt 1 (natural prose) failed after **6.3 minutes** (F17); attempt 2 (explicit
numbered steps) produced a 16-node workflow in ~8 min; approval jammed on an unrendered
node (F21); after the fix it ran to **16 / 16 APPROVED** and the test executed.

**The approval gate's RUN-TIME behaviour is still unverified, and F21 was not the reason.**
The test ran the `not_support` path, so the gate never fired. Still unproven:

- **whether rejecting actually blocks the send** — the single most important behaviour here
- Slack buttons / magic-link resolution, and that each authenticates its answerer
- timeout sweeping, and that silence resolves to `reject` as the spec declares
- `WEAK_APPROVAL_FOR_WRITE` at run time

**The blocker on all of it is now F16, not F21** — nothing drives a sample down the
approval path. To verify this end to end you need a sample that classifies as `support`.
The practical route is to send a genuine support-shaped email to the connected inbox and
re-run, rather than to wait for the example picker to choose one.

**Shapes 2, 5 and 6 were not reached.** Shape 6 (write-only) is the highest-value
remaining, since it exercises `isWriteNode`/`MISSING_DELIVER` and schema-aware column
mapping. Do not read their absence as evidence they are clean.

---

## The pattern behind the blocking findings

The four 🔴 findings are not four bugs. They are **one systemic failure with four
doors**, and fixing them individually will leave the system in the same state.

**The verification surface reports success for the absence of evidence.**

| Finding | Absence | Reported as |
|---|---|---|
| F3 | examples whose fixtures never reach the workflow | "4 real examples, every promise held" |
| F12 | zero examples at all | "Contract kept, every promise held" |
| F16 | two of three lanes never executed; no delivery ran | "every promise held" |
| F11 | no contract persisted anywhere | publish succeeds silently, SOP omits it |

In every case the honest verdict was **"not verified"**, and in every case the system
rendered **green + cleared to go live**. This is the exact failure `CLAUDE.md` names
repeatedly and in these words — *"a default that makes a check vacuous is not a safety
net; it is the bug"*, *"a check that silently degrades is not a safety net; it is the
bug"*, *"an uncheckable promise reported as met is the same failure as a missing
delivery, just better hidden."* The doctrine is already written down. The outcome oracle
does not follow it.

**Why this is worse than an ordinary bug.** The oracle is the product's central trust
claim — *"nothing goes live until you've tested it"*, *"checked automatically, shown here
so you can see it yourself."* A user who has been shown a green contract four times will
stop reading it. The feature is not merely failing to add safety; it is **actively
spending the user's attention budget** to certify things it did not check. A workflow
that moves money or emails customers can reach production this way with a full green
audit trail behind it.

**F17 is the same defect inverted, and it proves the diagnosis.** The approval-gate build
fails because the verifier reads *"this sample didn't reach the approval path"* as *"no
step can produce `approved`"* and rebuilds until it gives up. Same conflation, opposite
sign:

| | unexercised path resolved as | result |
|---|---|---|
| F3, F12, F16 | satisfied (optimistic) | **false pass** — ships unverified |
| F17 | unverifiable (pessimistic) | **false failure** — cannot ship at all |

The system has **no representation for "not exercised by this sample"**, so it must
guess, and it guesses inconsistently. This is why the four blockers are one bug: they are
the two possible wrong answers to a question the system cannot express.

**Practical consequence for whoever fixes this:** naïvely making the oracle stricter
(F16) without adding the third verdict will convert false passes into F17-style build
failures. **Add `not_exercised` first**, then make coverage a requirement, then drive
sample selection to satisfy it.

> **⚠️ This synthesis was written when every blocker lived in the build/verification layer.
> That is no longer true.** **F30** is an execution-path defect: a connector write inside a
> `foreach` receives no credentials and fails as "not connected". It was found only after
> fixing F29 and widening a query so the loop had rows — i.e. it was hidden behind two
> other defects and an empty inbox. The "one systemic failure" framing above still holds
> for F3/F12/F16/F17, but it is **not** a claim that the executor is clean. It is a claim
> about where the *verification* defects cluster. See F30, and read the coverage table
> before generalising.

**One rule would close all four:** *a verdict may only be computed over evidence that
exists — and "no evidence" is its own verdict, neither pass nor fail.* Concretely — an assertion is held only if a run exercised it; a lane is verified
only if a sample took it; a contract is kept only if it was checked against ≥1 example
that reached the asserted behaviour; and zero examples is `unverified`, never `kept`.
Everything else is presentation.

**Suggested order of work.**

**Do F21 first, before any of the below.** It is a small, self-contained rendering/queue
mismatch, it is unrelated to the oracle design work, and **nothing about approval-gated
workflows can be verified end to end until it is fixed** — the shape cannot be published.
It is the cheapest fix on this list and it unblocks the most testing.

0. **Introduce a `not_exercised` verdict** distinct from pass and from
   "unverifiable/rebuild". Nothing else in this list is safe to do first — F16 and F17
   pull in opposite directions until this exists.
1. **F12** first — smallest and most absurd (0 examples ⇒ not a pass). It is a guard
   clause, and it immediately stops the worst regression path (edit → certify nothing).
2. **F11** next — mechanical and self-contained (include `S.outcome` in the publish body;
   assert `spec_version = 2` and non-NULL `outcome` after publish). It unblocks
   `UNSATISFIED_ASSERTION` and the SOP sections, which several other guarantees rest on.
3. **F16** then — assertion-level "was this actually exercised" plus lane coverage. This
   is the real design work.
4. **F3** last — it partly dissolves once F16 lands (an unexercised assertion stops
   counting), leaving the narrower question of fixture generation for connector-read
   workflows.

**A warning about testing these.** Per `CLAUDE.md`'s mutation discipline: several of
these cannot currently fail. `shouldTrigger` is read by no code; a test asserting it is
honoured passes today only because nothing contradicts it. When you add each guard,
**re-introduce the defect and confirm the test goes red** — F3, F12 and F16 all reached
production behind a green suite, which is precisely the condition that lets a guard be
written and never verified.

## Open questions for the receiving agent

1. **Is real delivery during "Run test" intended?** (F4.) There is a standing operator
   preference for real Slack/Google/Airtable delivery in e2e over dry-run scaffolding,
   which suggests yes. If so the fix is disclosure in the UI, not a sandbox. **This is an
   operator decision — do not build a dry-run mode without asking.**
2. **What should a router's minimum sample set be?** (F16.) One-per-lane is the obvious
   floor, but for a decision table the lane count can be large. There may be an existing
   answer in the DMN coverage work (`decision-analysis.js` already subtracts boxes) worth
   reusing rather than inventing a second notion of coverage — `CLAUDE.md` is emphatic
   that two implementations of one rule drift.
3. ~~**Should test runs count toward console health metrics?** (F14.)~~ **ANSWERED
   2026-07-20 — no, and the question was a false binary.** Counting them makes the health
   band untrue; hiding them makes it disagree with the run-history list (which is why Q13
   reverted the filter in the first place). Both surfaces now count live runs and report
   the test count *alongside*, so nothing is hidden and nothing is overstated. See F14.

## Reproduction assets

Screenshots are in `tmp-g-verify/` (untracked). The load-bearing ones:

| File | Shows |
|---|---|
| `T08-plan-doc.png` | Plan document + provenance chips (F10 mislabel) |
| `T09-graph-built.png` | "3 steps" vs "0 / 4 APPROVED" (F8) |
| `T11-evidence-expanded.png` | "Multiple unread emails" ✓ on `{"messages":[]}` (F3) |
| `T15-zero-examples-passed.png` | **"Contract kept … 0 REAL EXAMPLES"** (F12, F13) |
| `T16-sop-no-contract.png` | SOP with no contract / escalation / provenance (F11) |

Database backups (pre-purge, 148 rows — the evidence for F11's historical claim):
`<scratchpad>/dbbackup/workflows.sqlite`. Archived builder sessions:
`<scratchpad>/converger-archive/`.
