# Demo readiness — the test → observe → fix loop

**Branch:** `loop/demo-readiness`
**Instrument:** `node scripts/checks/demo-scorecard.mjs [--log <path>] [--since <ISO>] [--json]`

The demo has to hold for **more than one workflow shape**. This loop exists so that
"it works" is a number rather than an impression, and so a shape that only works
sometimes cannot hide behind one good run.

## The three indicators

| # | Indicator | Target | Why it is measured this way |
|---|---|---|---|
| 1 | **Latency** — Approve & build → finished workflow | as low as possible, **per shape** | An easy shape builds in seconds. Pooling shapes lets a pile of cheap ones bury a hard one that regressed, so every figure is grouped by shape and the run count is printed beside it. A median of one is a reading, not a measurement. |
| 2 | **Rebuilds** — whole-spec generate passes | **exactly 1**, repeatably | Every pass past the first is a ~2-minute model call the user watches. The route that ordered each rebuild is named, because *which* loop fired is the whole diagnosis. |
| 3 | **Go live** — did the test certify | **no repeated shape breaks** | A pass is not enough on its own: a run that certifies on one sample and one covered lane is not the same result as one covering every lane, though both say "passed". The scorecard flags a pass **without full lane coverage as THIN**. |

### Two traps this instrument is deliberately built against

- **Averaging across shapes.** See indicator 1. Run the *same* shape repeatedly.
- **Reading "passed" as done.** A five-path workflow reached the panel with ONE
  example on 2026-07-28 and would have read as a clean pass. Coverage is reported
  next to every verdict for that reason.

*Caveat, stated because a wrong attribution is indistinguishable from a regression:*
verdicts (`test.summary`) carry no build thread, so the scorecard attaches each to
the most recent build that finished before it. With two people building at once this
can mis-attribute.

## Shape catalogue

Round 1 works these four. They are ordered by how much machinery they exercise.

| Shape | Prompt | Exercises |
|---|---|---|
| `linear` | "Every weekday at 9am, summarise my unread email and post it to #atlas-test-temp." | trigger → AI → deliver. The floor. |
| `digest` | "Every Monday, search the web for AI automation news and send me a digest." | multi-source assemble, web connector |
| `classify→route` | "When a new email arrives, classify it and add urgent ones to my Airtable, ignore spam." | branch, catch-all, table destination |
| `classify→approve→route` | "When a new email arrives, classify it. If it is an urgent customer complaint, send me a Slack DM asking me to approve it, and once I approve, post a short summary to #atlas-test-temp. If it is a normal enquiry, add a row to my Airtable instead. If it is spam, ignore it and do nothing." | everything: two branches, approval gate, three connectors |

## Baseline — `classify→approve→route`, prod, 2026-07-28

Three builds of the **identical prompt** across three deploys. This is the only
shape with repeat data so far.

| Built | Version | Latency | Passes | Rebuild routes | Lanes | Verdict |
|---|---|---|---|---|---|---|
| 15:38 | 1.6.46 | **623s** | **5** | sufficiency ×4 | — | failed |
| 16:28 | 1.6.47 | **464s** | **3** | blocking_gaps, gap_answer | — | failed |
| 17:11 | 1.6.48 | **163s** | **1** | none | 5 | **passed** |
| *(re-test)* | 1.6.49 | — | — | — | 5 | **passed**, 3/3 promises |

- **Indicator 1:** 623s → 163s (−74%)
- **Indicator 2:** 5 passes → 1
- **Indicator 3:** 0/2 → 2/2, and on 1.6.49 all three promises proven rather than two

**One shape, four data points. That is a start, not a result.** Nothing here says
the other three shapes behave, and nothing says this shape repeats — the same prompt
has been built once on 1.6.49.

## Round 1 — the fix list

Carried in from the QA pass, ordered by which indicator they move.

1. **Table-shaped destinations settled before the plan** *(indicators 1 and 2)* —
   today the columns are discovered after the whole workflow is built, and no
   rebuild can create a column in someone's account. Two of the three passes on the
   1.6.47 build went on exactly this. **Per-capability, never per-connector**
   (operator): Sheets, Notion and anything later must get it from the same
   mechanism. Behaviour: read the destination's real columns at the clarification
   turn and show them — *"Table 1 has Name, Notes and Date. I'll put the sender in
   Name and the subject + summary in Notes — or tell me to add Subject and Summary."*
2. **One recorded shape-of-truth** *(indicator 3's credibility)* — one workflow
   currently publishes four different shapes: the test panel says *3 steps · 3
   paths*, step approval says *13*, the plan card said *8 steps · 4 paths*, the
   oracle counts *5 lanes*. The panel stops at the first branch, so it structurally
   cannot see an approval gate downstream of a classifier. The number a person reads
   is not the number the oracle certifies against.
3. **The timeout warning on the approval card** *(cosmetic, but on camera)* — the
   card says a timeout counts as "reject", then the next screen warns in red that
   timeout has "no path of its own". Two screens disagreeing about the same
   configured behaviour.

## Round 1 results

| Shape | Latency | Passes | Rebuilds | Verdict |
|---|---|---|---|---|
| `linear` | **37s** | 1 | none | not run |
| `classify→route` | **64s** | 1 | none | **passed** (4 examples, 2 exercised the deal) |
| `classify→approve→route` (prod) | **163s** | 1 | none | **passed** (3/3 promises) |

- **Indicator 1** — 37s / 64s / 163s. The spread is the point: a pooled median
  across these would be meaningless, which is why the scorecard refuses to compute one.
- **Indicator 2** — **3/3 single-pass across three different shape classes.** The
  target holds beyond the one prompt it was first measured on.
- **Indicator 3** — 2 of 3 shapes certified; `linear` still unmeasured.

### The bug that round 1's own testing found

**A fully approved workflow could be permanently untestable, with no error shown.**
Witnessed after a mid-session server restart — which is what every deploy does to
anyone building at the time. The canvas read `7 / 7 APPROVED · every step approved`
while the panel beside it read "Building" with Run test greyed out under *"Confirm
every step to start testing"*. It survived a full page reload.

`awaitingGraphApproval` and `phase` are cleared by a server round-trip at the end of
the approval walkthrough; if that never lands they stay stranded, and the gate read
only those flags. The gate now also accepts the observable fact — a spec exists and
every step is confirmed — which cannot be lost in transit.

**The rule had THREE copies**: the contract panel, the footer, and `runTest` itself.
Unifying only the first two produced a worse failure than the original — the button
ENABLED and pressing it did nothing at all: no request, no error, no feedback. A
disabled button at least explains itself. All three now read one derivation.

## Backlog (operator, not priority)

- **Node-by-node progress during a test run.** When a test runs, the workflow nodes
  in the conversation pane should fire one at a time — every branch, every path —
  each toggling on as it passes. Today the canvas is static while the run happens
  and the evidence only appears at the end.

## Log

| Round | Date | Change | Shape(s) re-measured | Result |
|---|---|---|---|---|
| 0 | 2026-07-28 | baseline captured; scorecard + verdict logging added | classify→approve→route | see above |
| 1 | 2026-07-28 | column facts not regenerable; paths count every branch; timeout warning; columns settled pre-plan; skip reasons logged; OAuth origin refused; test gate unified across 3 call sites | linear, classify→route | 3/3 single-pass; classify→route certified |
