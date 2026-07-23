---
name: atlas-product
description: How the Atlas product is supposed to behave from a user's seat, and how to drive it live in a browser. Load this before doing any hands-on QA, live verification, or "does this actually work for a person" check on Atlas.
---

# Atlas, from the user's seat

This is the **behavioural contract** — what a person should see. It is not an
architecture doc. When this file and the code disagree, that is a finding: either
the product regressed or this file is stale, and you must say which, with evidence.

## What Atlas is for

Someone describes a job in plain words. Atlas interviews them, builds a workflow,
proves it works, and runs it on a schedule or an event. The whole promise is
**"you can trust it went live only because it was actually checked."** Almost every
serious defect this product has had is a violation of that one sentence — Atlas
saying something was verified when it was not.

So the question behind every test you run is: **did Atlas claim more than it
proved?**

## Driving it

Local: `npm start` (never bare `node src/api/server.js` — the API key won't load and
inference silently drops to a local model). It serves `http://localhost:3000`.
Production is `https://atlas.agntic.co` — **do not run destructive tests there.**

**Every live check runs in a headed, foregrounded browser the operator can watch**,
with each screenshot saved to disk and each step narrated *before* the click. This
is a standing rule from the operator, not a preference. "The tests pass" is not the
same as a person seeing the button work; a whole feature once shipped dead because
the Approve button sent a malformed request and only a real browser found it. If
you cannot open a headed window, say so and stop.

**A fix is not verified until the server was restarted after the fix hit disk.** The
dev server does not auto-reload. Check the process start time against the file's
mtime before you trust any result. A result from a stale process is noise that looks
like a finding.

### The event log is your instrument

`memory/logs/atlas-events.log` — JSON lines, one per HTTP request plus lifecycle
events. `grep -a` it (it can contain a NUL that stops plain grep early).

The two most useful:

- `converger.node` — one line per build stage with `ms`. This is how you catch
  "why did that take four minutes" without guessing. Stages, in order:
  `outcome → process → examples → analyze → plan → generate → destinations →
  decisions → gaps → verify → walkthrough → ratify`. `generate` is the expensive
  one (a whole-workflow model pass, 60–180s is normal). `paused: true` means it
  stopped for the user.
- `converger.blocker_to_chat` — Atlas gave up rebuilding and took a question to the
  user instead. Seeing this is usually *correct*; seeing it repeatedly for the same
  code means the user is being asked something they cannot resolve.

## The happy path, and what each screen must show

### 1. Describe it

`+` (top of the sidebar) → a composer. Type the job, press Return.

**Must:** Atlas replies with either a clarifying question or a restatement plus a
**Build it** button. **The button is the tell** — if the reply is prose with no
button, the model drifted out of its required format and the conversation
dead-ends. The user's only escape is to type "build it". Atlas retries once
automatically; a second failure is a finding.

**Must:** the restatement covers *every* branch the user described. A user who says
"urgent goes to Slack, normal goes to my inbox, ignore spam" and gets a restatement
mentioning two of the three has already lost.

### 2. The plan

**Must** show: the trigger; every step in order; a **Routes to** section listing
every path *including* the catch-all Atlas inferred; a failure policy; and a
**"you said this" / "I inferred this"** mark on each line. That provenance mark is
load-bearing — it is how a non-technical person knows what to check.

Then **Approve & build** or **Request a change**.

### 3. The build, and its reasoning

**Always expand the chain of thought** (the chevron at the right of "Building…")
and actually read it. It is the cheapest signal in the product. You are looking for:

- Does it restate the job correctly, or has it quietly dropped a branch?
- Is it reasoning about the *right* constraints, or spiralling?
- Does it contradict what it eventually built?
- Is the length proportionate to the job? A four-step workflow that thinks for
  three minutes is a finding.

Known-good signals, worth confirming still hold: it should say the approval step
sends its own Slack message (**not** a separate delivery step — that would message
the person twice), and it should set an unanswered approval to time out as a
**rejection**.

### 4. The questions ("gap review")

Atlas asks what it could not infer, each with a pre-selected default and a **Use
your suggestions** button, so a complete workflow can be built having typed nothing.

**Must:** the questions are in **plain English**. If a user is asked to judge
`inbox:Email Summary` or `urgent_approved` or `DIGEST_MISSING_SECTIONS`, that is a
finding, every time. Identifiers are the codebase's filing system, not English.

**Must:** answering makes the answer stick. See "Known open" below — it currently
does not, on complex builds.

### 5. Step approval

Each step appears as a card and must be confirmed. **Every step must get a card.**
The queue walks the steps by position, so a step that fails to render has no confirm
control — the queue stops dead, and the workflow can be neither tested nor
published, with no error shown. Count the cards against the steps. This is the
single highest-value manual check in the product; re-do it after any change to the
diagram.

The diagram itself must read **left to right**, with each path labelled, and must
never draw an edge the workflow does not have.

### 6. Run test

**Must:** the panel reaches a verdict and the timer stops. If it sits on "Testing…"
forever, that is a blocker — there is no escape but a page reload.

Verdicts you should see, and what each means:

- **kept** — the promise held, and something was actually checked.
- **broken** — it ran and did the wrong thing.
- **not exercised** — it ran but proved nothing. **This must NOT unlock Go live.**
  A sample that took a do-nothing path, a workflow with no promises, or a negative
  example ("should not trigger") all land here. The whole point is that Atlas
  refuses to certify rather than certifying blind.
- **paused** — the run stopped at an approval step. Also must not unlock Go live.

**Must:** if the workflow has three paths and the samples only exercised one, Atlas
says so and blocks. A router is only proved on the routes you test.

### 7. Go live

Locked until the test actually passed. A published workflow appears in the sidebar
and runs on its trigger.

## What counts as a finding

Report it if a **real user can hit it** and it either **looks like success** or
**destroys something** (data loss, one tenant's data reaching another, money moved,
a message sent that should not have been). That is a **blocker**.

Everything else — cosmetic, a path nobody can reach, a data-hygiene wart — is a
**residual**: recorded, named, carried, not fixed now.

**List every defect you find, including residuals.** Never omit one to make a report
look cleaner. Suppressing a finding to speed a merge is the failure this role exists
to prevent.

## The traps this product keeps falling into

Recognise these shapes; they recur in new costumes:

1. **Certifying the absence of evidence.** "Every check passed" over a set of zero
   checks. Ask *how many things were actually checked*, not whether anything failed.
2. **A green suite proving nothing.** Every serious defect in this codebase reached
   a merge-ready state behind a fully passing test suite. Never accept "the tests
   pass" as evidence that a behaviour works. Watch it work.
3. **The laundering hop.** A check that asks "who produced this value" instead of
   "what can this value be" is defeated by passing the value through one more step.
   Four separate defects have had exactly this shape.
4. **The silent default.** A `?? 'default'` on something security-relevant is not a
   safety net, it is the bug — it has produced a cross-tenant leak here before.
5. **The second executor.** Anything inside a loop goes through a different code
   path. A rule proven at the top level may simply not exist inside a `foreach`.
   Test the looped version separately.
6. **Doing the work twice.** An approval that messages the person, and then a
   delivery step that messages them again.
7. **A test that constructs its subject differently from production.** If a check
   passes something production omits (or omits something production passes), it is
   testing a program nobody runs.

## Known open — do not re-report as new; DO re-check

Read `docs/handoff/hardening-2026-07-22.md` (and the `-07-21` one) first, then
verify these are still true rather than assuming:

- **The same set-up questions are asked twice on a complex build**, and answering
  the second time still does not take effect — it rebuilds and re-asks. Bounded, so
  it gives up rather than looping. This is the top open defect.
- **A test example cannot influence a workflow that fetches its own data.** Every
  sample runs against the same live data, so they all prove the same one thing.
- **Test runs count toward the live health score**, so a workflow that has never
  fired for real can read "100% success".
- **Answering an approval IN the test panel now exists — but is unverified end to
  end.** The panel renders in-panel Approve/Reject for a paused approval and clicking
  one resumes the run (shipped `6ef6135`), so the old "an approval cannot be answered
  here" is STALE. What is NOT yet confirmed by anyone clicking it through: that the
  after-gate steps then resolve and Go live unlocks. There is a real reason it has not
  been clicked in QA — **clicking Approve runs the REAL after-gate steps, including
  real writes and sends, so a "test" can create real data**; the panel says as much.
  Treat post-gate behaviour as unproven until a run is answered and reaches a kept
  verdict. Still true and load-bearing: a run left PAUSED (unanswered) must never
  certify — do not make a paused run count as a pass.
