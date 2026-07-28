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

## Log

| Round | Date | Change | Shape(s) re-measured | Result |
|---|---|---|---|---|
| 0 | 2026-07-28 | baseline captured; scorecard + verdict logging added | classify→approve→route | see above |
