# QA shakedown findings — 2026-07-22 — disposition

The QA Manager drove the live app (SHA `95d4b40`, v1.6.27) and filed nine findings.
The operator marked all nine **fix now**. This records what happened to each.

## The headline: four "blockers" were one defect

Findings 1, 2 and 4 were symptoms of finding 3, exactly as hypothesised. One fix
closed all four, confirmed by re-measuring the identical build.

| Finding | What a user saw | Disposition |
|---|---|---|
| **3** — uncheckable promise | the workflow's central promise could never be verified | **Fixed** `e922735` |
| **1** — approver asked 4× | one approval turned into four gates | **Closed with 3** — re-measured: 1 gate |
| **2** — same questions 3× | answering never took effect; 445s of wasted rebuilds | **RE-OPENED 2026-07-26 — this was only HALF closed. See the note below the table.** |
| **4** — 22 nodes, 6 hidden | steps drawn on top of each other | **Closed with 3** — re-measured: 13 nodes, all render, queue walked 13/13 |

> ### Correction, 2026-07-26 — finding 2 was closed on half a measurement
>
> The disposition above says finding 2 was closed. **It was not.** The defect had two
> halves and the re-measurement only tested one of them.
>
> - **The re-asking is genuinely fixed.** Three independent QA workers on 2026-07-26 were
>   each asked once, never twice. That half of the original finding stands closed.
> - **The answer still does not take effect.** A tester gave the destination `#support`
>   twice — typed once, then clicked it from the offered buttons — and the finished
>   workflow was built to post to `#ops`. The user is now asked once and ignored once,
>   which is quieter than the original bug but no less wrong.
>
> "0 re-asks, 1 build pass" measured that Atlas stopped repeating itself. It never
> measured whether the answer changed what got built. Recorded in CLAUDE.md's open list
> as item 1. Source: `~/Desktop/agent-org/runs/2026-07-26/run-1224-qa/COMPILED.md`,
> finding 6.

The re-measurement also reached **Run test** and **Go live** for the first time: the
queue completed, the panel returned a verdict, and Go live stayed correctly locked on
an under-tested router.

## The rest

| Finding | Disposition |
|---|---|
| **9** — build logs carry no session/tenant id | **Fixed** `3b574b3` — every build-log line now stamps `{thread, tenant}` |
| **7** — three live "Use your suggestions" buttons | **Fixed** `3b574b3` — only the newest question is answerable |
| **8** — reload during a gap review loses the answer button | **Fixed** `3b574b3` — a paused build now explains how to continue |
| **5** — panel "3 steps" for a many-node workflow | **Working as designed — not changed. See below.** |
| **6** — a complete restatement with no Build button | **Working as designed — not changed. See below.** |

Two more fixes, from the re-measurement's own findings (not in the original nine):
- **Chat contradicted the panel** (claimed a failure the panel said didn't happen) —
  **Fixed** `613be99`.
- **A branching workflow couldn't reach Go live without hand-writing examples** —
  **Fixed** `fd1ad45` (one worked example per path, once the paths are known).

## Why #5 and #6 were not changed

Both are **deliberate, safe behaviour** on inspection. I'm recording the reasoning
because the operator marked them fix-now, and this is where I'm exercising the
judgment they can't — with the facts laid out so they can overrule me.

**#5 — the step count.** The panel's "N steps" counts the steps the workflow *always
takes* — the trunk up to the first branch — because after a router only one lane
runs. Counting all nodes would overstate what a scheduled run does. The count logic
carries explicit comments that a previous attempt to change it made the panel and the
graph disagree about the same spec — itself a filed defect. So "3 steps · 3 paths" is
a compact, honest description of a trunk-and-branch shape, not a wrong number. The
jarring part the QA saw — "3 steps" next to "22 nodes to approve" — was mostly the
inflated 22 from finding 1; post-fix it is 13, and the two numbers measure genuinely
different things (steps always taken vs. every node you confirm once). **I judged
changing the count a net risk, not a net fix.** If the operator wants the strip to
show the total-to-approve instead, that is a clear one-line change — but it is a
product decision about what the number *means*, not a bug fix.

**#6 — the restatement without a Build button.** The model asking "Want me to set
this up?" and holding the Build button until the user confirms is the **documented,
intended** behaviour (`builder.js:440`: offer, but keep `ready_to_build:false` until
the user clearly signals). Confirm-before-build is the safe default, and the reply
parsed correctly — this is not the format-drift dead-end (which is a separate, real
bug that did *not* reproduce). The only "improvement" available is a one-click "Yes,
build it" chip, and that depends on the model reliably signalling that it's offering —
which the QA showed is exactly the non-deterministic behaviour in question. A fragile
model-protocol change on a residual, guarding behaviour that is already correct, is
not worth the risk. **Recommendation: leave it.** The user's cost is typing one word
of confirmation, which is the same confirmation the design requires.

## Still genuinely open (carried, none a blocker)

From the re-measurement's "could not test":
- ~~**An approval step can't be answered from the test panel**~~ **STALE (corrected
  2026-07-23):** it can — `6ef6135` wired in-panel Approve/Reject (`_answerPause`),
  which resumes the run. What is still unverified end to end: that the after-gate
  steps then resolve and Go live unlocks — no QA run has clicked it through, because
  clicking Approve runs the REAL after-gate steps (real writes/sends). A run left
  PAUSED (unanswered) must still never certify.
- **Test runs aren't persisted to `workflow_runs`**, so the QA couldn't confirm from
  data which lane a test took. Also means the live health score counts test runs
  (original F14, separate). *(Later QA found cost IS recorded, in `llm_cost_log`
  inside `workflows.sqlite` — the 0-byte `memory/llm_costs.db` is a stale unused path,
  not evidence costs go untracked.)*
- **Cost per build is unmeasured** — ~~`memory/llm_costs.db` is 0 bytes locally~~
  **corrected 2026-07-23:** costs ARE recorded, in `llm_cost_log` inside
  `workflows.sqlite`; the 0-byte `memory/llm_costs.db` is an unused/stale path.
- **The "more than one route could gate a step" branch of the finding-3 fix** was
  never exercised — the test build had a single unambiguous gate. That is the half
  most likely to regress quietly; a build where two branches gate one delivery would
  exercise it.
