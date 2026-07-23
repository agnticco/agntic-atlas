# P12 build log — the promise system (increments A–G) + 2026-07 hardening

> **Archived from CLAUDE.md on 2026-07-23.** This is the verbatim per-increment
> build diary of P12 (the outcome-contract / promise system) and the July 2026
> product-hardening findings. It was moved out of the Build Constitution because
> P12 has been closed and running in production for weeks — the granular defect
> narratives are history, not guidance a new session needs to load every time.
> The recurring engineering doctrine distilled from this diary lives in CLAUDE.md
> under **"Hard-won lessons"**. Nothing here was deleted; it was relocated.
> Read this when you need the full story behind a specific defect or invariant.

---

- **Node library re-cut + `UNKNOWN_CONFIG_KEY` (2026-07-13, P12 increment A)** — the node library
  had eleven types; three could never run and four were `llm.js` with a different prompt. It is now
  **`trigger · llm · assemble · connector-action · search_web · deliver`**.
  - `src/workflows/node-types/llm.js` gains **`mode: summarize|extract|rewrite|classify|freeform`**
    and absorbs the prompts of the types it replaces. `summarize.js`, `extract.js`, `rewrite.js`,
    `tool.js`, `mcp-tool.js`, `fetch.js` **deleted**. `daily-digest.js` → **`assemble.js`**: it was
    *not* an LLM node (its `run()` took `(cfg, _ctx, _services)` and never called the model), so
    collapsing it into `llm` would have turned free, deterministic string assembly into a paid
    model call. Renamed, behaviour identical.
  - **`classify`** is new and load-bearing for increment C: it is the only sanctioned way for an
    LLM to feed a decision, because it classifies into a **closed enum** and throws on an off-enum
    answer instead of passing free text downstream.
  - **`src/workflows/node-types/compat-v1.js`** (new) — `liftV1Node()` maps the old types to the
    new ones. Called from **exactly two** places: `WorkflowValidator.validate()` and
    `FlowTester._runNode()` (the scheduler and the REST run path both execute through FlowTester).
    **No DB migration**: v1 specs are lifted on read, never rewritten on disk.
  - `src/workflows/workflow-validator.js` — new **`UNKNOWN_CONFIG_KEY`** (a config key not in the
    type's `configSchema` is an error, not a shrug), `REMOVED_NODE_TYPE`, `UNKNOWN_LLM_MODE`. The
    dead `fetch`/`tool`/`mcp_tool` branches of `_checkTypeSpecific` are gone.
  - **`UNKNOWN_CONFIG_KEY` is scoped by a new `configPolicy` on each node type** (`'closed'` by
    default; `connector-action` is the only `'open'` one, because its params are per-capability).
    A blanket subset check was **impossible**: it rejects the frozen canonical spec (whose
    `summarize` node carries `instructions`/`format`, which the v1 schema never declared) and the
    ordinary Slack/Gmail delivery shapes. Keys the handlers genuinely read
    (`deliver.target|user|to|subject|username|icon_emoji`, `search_web.query`) are now **declared**,
    because the schemas were lying — a key no code reads (`llm.model`) is a hallucination and
    errors; a key a handler reads but the schema omitted is an untrue schema and gets fixed.
    **Never declare a key `run()` doesn't consume, and prove the consumer with a word-boundary grep
    before you declare it.** Increment A briefly declared `deliver.message` on a misread (a grep for
    `config.message` **prefix-matched `config.messageId`**, a `gmail_get_message` param); the
    independent verifier caught it. Nothing reads `config.message`, so such a deliver node has its
    content **silently dropped** at run time — defect #3, re-created inside the check built to kill
    it. It is rejected, and pinned by a test.
  - `scripts/gates/p12.sh` — `run_test()` now runs `node --env-file-if-exists=.env --test` **and
    fails closed on any skipped test**. It previously ran the E2E with no env file, so the gate's
    own regression step hit the self-skip trap: `tests/e2e/full-journey.test.js` skips its converger
    test without `ANTHROPIC_API_KEY` and still reports a cheerful "6 pass / 1 skip" — the skipped
    one being the thing under test. The gate was passing itself on a suite that had quietly not
    tested the converger. *(Making a check stricter, not weaker — CLAUDE.md, Gates.)*
  - `src/converger/prompts.js` — **the actual root cause of the `model` hallucination**: the prompt
    advertised `llm: (config: prompt, model)`, i.e. it *told* the model to emit a key no schema
    had. Now it teaches `llm` + `mode` with the closed key set, and states that `model` does not
    exist. The converger emits v2 nodes natively (verified against the live LLM).
  - `scripts/checks/p3-converger-run.mjs` — asked `n.type === 'summarize'`. That asks about an
    *encoding*, and the encoding changed; P3 actually asserts a *role*. Now checks
    `llm` + `mode:'summarize'` **via the same lift**, so both spellings satisfy it. Not weaker: a
    spec with no summarizing step still fails. *(Fixing the check, not weakening it — CLAUDE.md,
    Gates.)*
  - Also updated for the re-cut: `sop-generator.js` (mode-aware labels — an SOP is customer-facing,
    so a step that read "Summarize (LLM)" must not start reading "AI step"), `run-enricher.js`,
    `output-validator.js`, `workflow-scheduler.js` (`_collectToolsUsed` read only the two deleted
    types, so it would have returned `null` forever — it counts `connector-action` capability ids
    now), `error-translator.js`, and `public/index.html` (one `effNodeType()` helper so an
    `llm`+`mode` node still renders as a "Summarize"/"Extract" card, not a generic λ).
  - **Fixed in passing:** `flow-tester.js` tested `node.type === 'search-web'` (hyphen) for the
    long-timeout path, but the registered id is `search_web` — so every web-search step had been
    silently getting the *short* timeout.

- **Engine control flow (2026-07-13, P12 increment B)** — the engine could only run a DAG
  straight through: no conditionals, no loops, no pause, no retry, no dedupe. It now has all five.
  New node types `branch` / `foreach` / `human` (`src/workflows/node-types/`), plus two node-level
  attributes, `on_error` and `idempotency`. `decision` is increment E; `wait` is unbuilt.
  - **Liveness is tracked on EDGES, not nodes** — `src/workflows/flow-tester.js`. An edge goes
    live when its source completes; out of a `branch`, only the selected case's edge does. A node
    is skipped iff it has incoming edges and NONE is live. **The design doc originally specified a
    node-level `active` set, and that is wrong**: it skips a JOIN (a node downstream of both the
    taken and the untaken path has one live parent and one dead one, and any rule phrased over
    parent *nodes* kills it). converger-v2.md §4 is corrected. A skipped node emits `step_skipped`,
    never `step_failed` — it is not a casualty.
  - **§11.2 falls out structurally**: with no `branch` in a spec, every edge goes live the instant
    its source completes, nothing is skipped, and the loop is the old one. The test asserts the
    exact event sequence is unchanged — that is what protects the workflows already in production,
    none of which use control flow.
  - **THE PERSISTED STEPS ARE NOT THE CHECKPOINT.** `workflow_runs.steps` holds the
    **display-shrunk event stream**: `_shrinkOutput` truncates at 2000 chars, appends a literal
    `…(truncated)`, and JSON-encodes objects, so the UI isn't flooded. The first design resumed
    from it — and a 3363-char drafted email came back as 2013 chars, so **the person approved one
    thing and the customer received a different, mutilated one**, ending in `…(truncated)`, with no
    error and a `run_completed`. ~400 words is nothing for a drafted reply, so every real approval
    would have resumed on corrupt state. The run now emits an explicit **`checkpoint`** on
    `run_paused` (`{outputs, skipped, live, ruledOut, lastOutput}` — the last two are load-bearing, see
    below — full fidelity), persisted to
    `workflow_runs.checkpoint`; it is written only on a pause, so it costs nothing on runs that
    never pause. **Rule: anything reading back a persisted step gets a DISPLAY COPY, not the live
    value.** (Found by the independent verifier. converger-v2 §7.4 asserted the opposite and is
    corrected.)
  - **`branch` and `human` are CONTROL nodes — their output never becomes `lastOutput`.** A
    branch's output is `{value, matched, to}`, a human's is `{decision, by, at, channel}`. `deliver`
    sends `ctx.lastOutput`, so leaving them in meant the step after an approval delivered the
    literal `{"decision":"approve",…}` to the customer instead of the approved reply. **This holds
    on BOTH executors** — the top-level loop (`flow-tester.js`, `CONTROL_TYPES`) *and* the `foreach`
    sub-loop, which has its own executor (`foreach.js`, `CONTROL_SUBSTEP_TYPES`). The sub-loop was
    missed at first: a validator-clean spec with a `branch` inside a `foreach` delivered
    `{"value":…,"viaCatchAll":true}` to the customer once per item (found by the independent
    verifier, round 8). A `branch` in a loop is now **rejected** (`BRANCH_IN_FOREACH`) — it is a
    structural no-op there anyway (a loop has no edges, so nothing routes) — and the engine drops
    control-node output from `last` regardless, since DB specs predate the rule.
  - `src/workflows/workflow-store.js` — `workflow_runs.status` CHECK widened to include
    **`awaiting_human`** (a run waiting on a person is not running, not a success, and not an
    error; leaving it `running` gets it swept as stale). SQLite can't alter a CHECK in place, so
    this is a probe-then-rebuild mirroring the existing `_migrateStatusCheckIfNeeded`. New columns
    `paused_node`, `pending_ask`; new methods `pauseRun` / `listAwaitingHuman` / `markRunResumed`.
    **A table rebuild must carry over EVERY column the old table had — not just the ones its DDL
    lists.** The first version copied `newCols ∩ oldCols`, which is a silent column-stripper: this
    table is *not* fully described by its `CREATE TABLE` plus `ADDITIVE_RUN_COLUMNS` — `read_at` is
    added by its own one-off `ALTER` further down `init()`, **after** the rebuild — so on any
    database where a previous boot had added it, the rebuild dropped it and re-added it empty. The
    independent verifier reproduced it on the real 653-row DB. The rebuild now `ALTER`s any unknown
    old column into the new table before copying, so the whole class is closed by construction
    rather than by anyone remembering to mirror the next column. Verified against a prod-shaped
    legacy DB: 653 rows and all 653 `read_at` values preserved, and `init()` twice is a no-op.
  - `src/workflows/idempotency-store.js` (new) — SHA-256 of the resolved key, scoped
    **`tenantId:workflowId:[foreachId/]nodeId`**. **A node declaring an idempotency key with no
    store wired — or with no tenant/workflow to scope it to — REFUSES to run.** Both are
    fail-closed, and the second one is why: the scope was originally
    `` `${workflowId ?? 'unscoped'}:${node.id}` ``, and **neither production caller passed
    `workflowId`**, so every tenant collapsed into one namespace (`unscoped:create_record`) in a
    store with no tenant column — tenant B's write was silently skipped and **tenant B's step was
    handed tenant A's output**, which then becomes `lastOutput` and is delivered. A cross-tenant
    leak, out of a `??` default. **A silent fallback is not a safety net; it is the bug.** Wired in
    `server.js` (`IDEMPOTENCY_DB`); the scheduler and the REST run path both pass
    `tenantId`/`workflowId`.
  - `src/workflows/workflow-validator.js` — `NON_EXHAUSTIVE_BRANCH` (every branch needs a `*`;
    without one an unanticipated value matches nothing and the workflow **silently does nothing**,
    which is the most expensive failure a router has and is invisible exactly when it matters),
    `BRANCH_CASE_NO_EDGE`, `BRANCH_TARGET_EXTRA_PARENT`, `ON_ERROR_ROUTE_NO_EDGE`,
    `ON_ERROR_BAD_TARGET`, `NESTED_FOREACH`, `HUMAN_IN_FOREACH`, `WRITE_WITHOUT_IDEMPOTENCY`
    (warning). Branch rules live in the validator, not in `branch.js`'s `validate(node)` hook,
    because they need the **edge list**.
  - **A ruled-out branch target is DEAD, not merely unlit.** Edge-liveness alone has a hole: if an
    untaken case target *also* has an edge from an earlier node, that edge is live whichever way
    the branch went — so the step runs anyway and **the branch decides nothing**. The engine marks
    non-selected case targets dead outright, and `BRANCH_TARGET_EXTRA_PARENT` rejects the ambiguous
    shape at build time. (Found by the independent verifier.) The engine does not rely on the
    validator having run — specs already in the database predate the rule.
  - **LIVENESS IS RESTORED FROM THE CHECKPOINT, NEVER RE-DERIVED.** The checkpoint carries
    `{outputs, skipped, live, ruledOut, lastOutput}`, and a replayed node **propagates nothing**.
    Re-running `propagate()` for already-done nodes is wrong, because it lights **all** of a node's
    outgoing edges while the original leg may have lit only **some**: a `branch` lights one case,
    and an `on_error: route_to` lights only the error target. Re-deriving therefore **revived the
    path the branch ruled out** *and* **revived the HAPPY path of a step that had failed** — the
    run went on to deliver as though the payment had not been declined. Liveness is a fact about
    what happened, not something to recompute from outputs. (Both found by the independent
    verifier; the second only surfaced when probing the first.)
  - **`branch` / `human` outputs are never `lastOutput`, and never a transform's input.** Two
    separate guards — `CONTROL_TYPES` in `flow-tester.js` (what `deliver` sends) and
    `NON_CONTENT_TYPES` in `node-types/_node-input.js` (what an `llm` step ingests). Miss either
    and the approval record `{"decision":"approve","by":"user:1",…}` reaches the customer, or the
    model.
  - **Never use an unprintable character as a separator.** The branch/edge lookup key was first
    built with a literal **NUL** (`${from}\0${to}`) — invisible in an editor and in a diff — and it
    silently failed to match the one site that used a space, so `ON_ERROR_ROUTE_NO_EDGE` fired on
    *every* `route_to` and the feature was unpublishable. This is the same class as the `server.js`
    NUL in Known gotchas below. `tests/workflows/control-flow.test.js` now fails if **any** file
    under `src/` contains a NUL byte.
  - **A GREEN SUITE PROVED NOTHING FOUR TIMES RUNNING. Mutation-test, don't trust the tick.** Every
    defect in this increment reached `main`-candidate state behind a passing suite, because each
    test passed *for the wrong reason*: the `route_to` test was **negative-only** (it would have
    passed if the check were `if (true)`, and indeed the check was rejecting every *correct* spec);
    the resume test's stub LLM returned **16 characters**, so it never crossed the 2000-char
    truncation cap; and it asserted a delivery *ran*, never *what it sent*. Two guards
    (`NON_CONTENT_TYPES`, the `doneSkipped` split) could be **deleted entirely with the suite still
    green**. So: **every validator rule needs a POSITIVE case** (the good shape is *accepted*), and
    **every guard must be mutation-tested** — re-introduce the bug and confirm a test actually
    fails. **Do not quote a mutation score in a doc** — two rounds here published one ("7/7",
    then "11/11") and an independent verifier falsified both by writing its own, wider list. A
    score is a claim about tests you did not write. State the RULE and let the next verifier
    re-derive the number.
    **Mutation-test the guards you add in the FIX, not just the ones you started with.** Both false
    scores came from exactly that: the round-4 fix introduced `checkpoint.ruledOut` and the
    "don't recompute `lastOutput` on replay" rule, never re-tested them, and **both survived
    deletion with the whole suite green** — dropping `ruledOut` let a ruled-out branch run and
    deliver on resume, verbatim the bug that commit was written to kill.
    **A test can be labelled `(pinned)` and not be pinned.** The `lastOutput` test said so in its
    own name while a `draft` node in its fixture laundered the value and masked the mutation
    entirely. Assert the DELIVERED BODY, put nothing between the step under test and the assertion,
    and *run the mutation*.
  - **`foreach` sub-steps must go through the same POLICY path as any other node.** They called the
    raw dispatcher, which silently skipped **`idempotency` and `on_error.retry` for every step
    inside a loop** — inverting the guarantee in the worst possible place. A write in a loop is N
    writes per fire (the highest-risk write shape the engine has, and the whole reason `foreach`
    exists), and it was the *only* shape where declaring an idempotency key did nothing: a sub-step
    with a key and **no store wired wrote twice and reported success**, while the identical
    top-level node refused to run.
  - **A `foreach`'s `steps` must NOT be template-substituted before the loop.** They were, with no
    item in scope, so `{{item}}` was replaced by an **empty string** before the first iteration —
    meaning `{{item}}` never bound at all, and an idempotency key of `{{item}}` resolved to `""`
    (falsy), skipping the dedupe check entirely. The test that "proved" `{{item}}` worked was
    passing for the wrong reason: the item reached the prompt only via `llm`'s auto-injection of
    `lastOutput`.
  - **`BRANCH_BAD_ON`** — the value a branch routes on is the one thing the node exists to read, and
    it was the one thing never checked. A one-letter typo (`clasify.output`) is not a template, so
    `BAD_TEMPLATE_REF` never fired; the engine took it as a literal, nothing matched, and the
    **mandatory catch-all then swallowed 100% of traffic — forever, silently, with
    `run_completed`**. The catch-all that exists to prevent a silent misroute was *masking* one.
    Rejected at build time.
  - **A `branch`'s `on` is a REFERENCE, not a template — it must stay RAW** (same carve-out as a
    `foreach`'s `steps`). The first fix for `BRANCH_BAD_ON` shipped two regressions, both of which
    crashed *valid* workflows, and both because `_runNode` substitutes config before the node sees
    it:
    - `on: "{{classify.output}}"` — the mainline shape — arrived as the classified **value**
      (`"urgent"`), which is indistinguishable from a step id, so the engine looked up a step called
      "urgent" and killed the run. **Data-dependent**, which is worse: `"urgent"` matched the id
      regex and crashed; `"needs review"` (a space) did not. Not one of the then-49 tests used the
      braced form.
    - The engine must distinguish **"no such step"** (a typo → fail loudly) from **"a real step that
      didn't run on this leg"** (an upstream branch skipped it → take the **catch-all**, which is
      exactly what a mandatory catch-all is *for*). Throwing on the latter failed a workflow the
      validator correctly accepts. `ctx.nodeIds` is what tells them apart.
  - **`scripts/gates/p12.sh` — one DESCRIPTION string changed** ("resumes from persisted steps" →
    "resumes from its checkpoint"). **No check was altered.** Recorded here because a diff against
    `scripts/` is exactly how a verifier detects a builder weakening their own gate — so it must
    never be silent. Left as-is, the gate itself would have taught the next agent the lie.
  - **`{{item}}` / `{{index}}` are bound ONLY inside a `foreach`.** Used anywhere else they are a
    `BAD_TEMPLATE_REF` at build time, rather than an empty string at run time.
  - **A `human` node is unreachable by design until increment D.** The engine pauses correctly, but
    nothing DELIVERS the ask yet (Slack buttons, signed magic links, the Approvals inbox are D).
    The converger doesn't emit one and the builder can't add one, so no user workflow can park
    itself waiting for a question nobody will ever be asked. **Do not surface `human` in the
    converger prompt or the builder until D lands.**

- **Converger v2 core — the outcome contract (2026-07-13, P12 increment C)** — the converger could
  agree to post to Slack **and** email the team, build only the Slack step, and nothing in the system
  could notice: no part of a spec ever declared what the finished workflow was supposed to
  **produce**. Spec v2 adds `outcome{statement, assertions[], examples[]}`, and a spec that does not
  deliver on its own contract **does not publish**.
  - **`src/workflows/outcome-oracle.js` (new)** — the SINGLE satisfaction oracle, imported by BOTH
    `workflow-validator.js` (`UNSATISFIED_ASSERTION`) and `converger/gap-scorer.js`. Two copies of
    this rule would drift, and the day they drift is the day the converger ratifies a spec that
    publish rejects — a dead end the user cannot argue their way out of. Assertion kinds are a
    **closed set** (`message_sent · record_exists · document_exists`); an assertion outside it is
    `MALFORMED_ASSERTION`, **never a silent pass** — an uncheckable promise reported as met is the
    same failure as a missing delivery, just better hidden.
  - **`src/converger/gap-scorer.js` (rewritten)** — `scoreGap(spec, {capabilities}) → {gaps, complete}`,
    three classes (outcome/coverage/contract). The old five-item checklist demanded a *processing*
    node, which is why the converger invented a pointless LLM step for a genuinely two-step workflow
    and charged for it on every run (defect #4). **The contract/outcome gaps ARE the validator's
    issues, classified — not a second opinion.**
  - **A BLOCKING gap can NEVER default to `'escalated'`.** converger-v2 §3 specified a blanket
    `'escalated'` default; that is **unimplementable** — it makes `complete` unconditionally true, so
    an EMPTY draft scores complete and the converger ratifies a workflow with no steps. Escalation
    promises a person handles the case **at run time**, and a spec that cannot publish has no run
    time. Blocking ⇒ `'unanswered'`, which buys **`complete ⇒ publishable`** by construction. **A
    default that makes a check vacuous is not a safety net; it is the bug** — same class as the
    `?? 'unscoped'` tenant fallback that leaked across tenants in B. §3 is corrected.
  - **`LLM_INPUT_NOT_ENUM` (§11.7, THE MOAT) covers TWO shapes.** Scoped to `decision` inputs alone
    it would guard **nothing that can run** — `decision` is not a registered node type until E, so
    the check would be pure theatre. The shape that *can* run today has the identical defect: a
    **`branch` routing on an `llm` node not in `classify` mode**. A branch matches by exact value, so
    free prose matches nothing and **the mandatory catch-all silently swallows 100% of traffic**,
    with `run_completed` and no error — verbatim the `BRANCH_BAD_ON` failure through a different
    door. This forced the one edit to a prior increment's test (`control-flow.test.js`'s
    skipped-step fixture routed on a *freeform* llm; the mode was incidental to the invariant it
    pins). The fixture was changed, the assertion left untouched, and **the test was re-mutation-
    tested to confirm it still goes red when B's original defect is restored.**
  - **`deliver` keys are deliver's ∪ the CHANNEL's — a LIVE defect from increment A, fixed here.**
    A delivery channel is a capability with its own params: `sheets_append`'s handler reads
    `config.spreadsheetId`/`config.range` (`src/connectors/google/index.js:694`),
    `airtable_create_record` reads `baseId`/`tableId`/`fields`. None is a `deliver` key, so **every
    delivery to a Sheet or an Airtable base was rejected at publish** — while the converger's system
    prompt rendered exactly that shape from the channel catalog and told the model to emit it. The
    builder was instructing users to build workflows it would then refuse to save. (Slack/Gmail
    escaped only because their keys overlap deliver's own.) This **narrows a lie in the schema; it
    does not widen the check** — `model` and `message` are still rejected. It is why `scoreGap` takes
    `capabilities`: the gap scorer must judge against the same channel catalog the server has, or
    `complete ⇒ publishable` is aspirational rather than true.
  - **The outcome is a FLOOR, not a ceiling.** It proves nothing was silently **dropped**; it cannot
    prove every transformation is **present** — *"a summary of the email"* and *"the email"* reach
    Slack as the same assertion, and inventing an assertion that claimed to tell them apart would be
    a proof we cannot make. So once the floor is met the INTENT gets the last word: `analyze` asks
    the model once if the draft is finished and it must **name** a concrete missing component to
    continue (bounded). Unlike v1's checklist, "finished" is the default answer — so a 2-node
    workflow still ratifies untouched.
  - **`assertion.when` is carried but NOT proven** — proving it needs `decision` (E) + the examples
    as a test suite (G). A conditional assertion therefore raises a non-blocking
    `CONDITIONAL_UNPROVEN` gap rather than being counted satisfied by an ungated node, which would
    let the workflow pass its own contract while pinging `#sales-urgent` for **every** lead.
  - **No `decisions` graph node, and no `human` in the prompt.** converger-v2 §3 listed a `decisions`
    node that "builds tables"; it cannot — the `decision` node type does not exist until E, so it
    could only emit an unrunnable spec. Same trap as surfacing `human` before D builds the surface
    that asks it. A decision today is `llm`+`classify` → `branch`.
  - `mutation-sweep.mjs` `TARGETS` widened to `workflow-validator.js` + the three C files (the round-9
    residual). It immediately found that **most of the pre-existing validator publish gate**
    (`MISSING_TRIGGER`, `CYCLE_DETECTED`, `DELIVER_NO_INPUT`, `SELF_LOOP`, `UNKNOWN_CHANNEL`, …) was
    pinned by **no test at all**. The floor is a ratchet: it was **not** lowered to accommodate the
    new files.
  - Also: `interaction-store.js` handled exactly three event types and **silently dropped every
    other** — so the moment the graph gained an interrupt, its entire record would have vanished with
    no error. It now stores unrecognised events, plus a `converger_provenance` table (which turn
    produced each assertion; which gaps escalated by default) that feeds the SOP.

- **The five defects the `test-adversary` found in C — all behind a fully green suite (2026-07-13).**
  Same lesson as B, and it landed on the first run of the agent built to prevent exactly this.
  Pinned by **`tests/converger/moat-adversarial.test.js`**, which is now in the gate and in the
  mutation sweep.
  1. **THE MOAT WAS BYPASSED BY ONE LAUNDERING HOP.** `LLM_INPUT_NOT_ENUM` asked *"is the branch's
     source an `llm` node that isn't classifying?"* — **a denylist**. Put an `assemble` between a
     freeform `llm` and the `branch` (`content: "{{think.output}}"` — a shape the converger is
     explicitly taught to emit) and the check never fires: `validator.ok === true`. The branch then
     routes on free prose, nothing matches, and **the mandatory catch-all swallows 100% of traffic,
     silently, with `run_completed`** — verbatim the failure `BRANCH_BAD_ON` exists to prevent. Same
     hole through `search_web` and `connector-action`. **§11.7's property is "the routed-on value has
     a CLOSED, DECLARED domain", not "its parent isn't an LLM" — laundering a value through another
     node does not bound its domain, it only hides who produced it.** It is now an **allowlist**: a
     branch may route only on `llm`+`classify` (categories), `decision` (output values), or `human`
     (approve/reject/timeout). A new source type earns its place by **declaring its value set**.
     **A denylist on a security-relevant property is the same class of bug as a `??` default: it is
     wrong by construction, and it fails silently.**
  2. **A malformed decision rule silently covered the WHOLE table.** `rule?.when?.[key]` on a `null`
     rule yields `undefined`, which the analyser reads as `-` (irrelevant) — i.e. "covers every
     value on every dimension". One bad rule (exactly what an LLM emits) made `analyzeTable` report
     `uncovered: []` **and** `hasCatchAll: false` simultaneously, which cannot both be true: a clean
     bill of health for a table it could not read. That is the **false proof** the module's own
     header forbids. A rule with no readable `when` is now `decidable: false`.
  3. **Duplicate assertion ids dropped an assertion.** `checkOutcome` keyed `satisfied` by
     `a.id ?? a.target`, so two assertions sharing an id collapsed to one Map entry — falsifying the
     single property the oracle exists to guarantee. Worse, the survivor carried the *first*
     assertion's `fields`, so a second assertion's `fields:['Budget']` was checked against a list
     that never mentioned Budget and **a spec that never wrote Budget published clean**. Keyed by
     **index** now (unique by construction), plus `DUPLICATE_ASSERTION_ID`. **A key that CAN collide
     is a silent drop waiting to happen.**
  4. **`integer` inputs got a PHANTOM gap.** The domain was partitioned over the reals, so `<=0` +
     `>=1` — exhaustive over the integers — reported an uncovered cell *"between 0 and 1"*. That is
     the module's *other* named failure mode ("invent a gap that isn't there"), and it is the more
     corrosive one: **a question with no real answer is what teaches people to click past the
     questions.**
  5. **A `null` node made `validate()` THROW**, and `WorkflowService.create()` calls it with no
     try/catch — so publish returned a **500** instead of the clean `MALFORMED_NODE` the validator
     had already generated one line earlier. Pre-existing on `main`. Malformed nodes are now removed
     from the working set before any check runs. **Turning bad input into a message is the
     validator's entire job; crashing on bad input is the one thing it must never do.**
  - **`scripts/gates/p12.sh` and `mutation-sweep.mjs` SUITES both gained `moat-adversarial.test.js`.
    Checks ADDED, never weakened** — recorded because a diff against `scripts/` is how a verifier
    detects a builder quietly weakening their own gate, so it must never be silent.

- **The independent verifier then FAILED increment C, and was right (2026-07-13, round 2).** The
  headline invariant was false and **the check written to prove it could not fail**. Third time this
  phase; the lesson keeps arriving in a new costume.
  - **`complete ⇒ publishable` was FALSE with no channel catalog.** The validator's channel checks
    sit behind `if (channelId && this.channelRegistry)` — so with no registry `UNKNOWN_CHANNEL` and
    `CHANNEL_UNAVAILABLE` **silently do not run**, while publish (which always has one,
    `server.js:542`) still enforces them. A `deliver` to a hallucinated `channel:'discord'` scored
    **complete** and then failed to publish: the builder says done, the save button says no.
    It **disabled itself exactly when it mattered** — `builder.js` built the catalog after three
    network-bound connector lookups inside a *"non-fatal"* catch, so an expired refresh token dropped
    it, and in that same state the model has no catalog in its prompt either and is at its **most**
    likely to invent a channel id. **A check that silently degrades is not a safety net; it is the
    bug** (the `?? 'unscoped'` lesson, third occurrence). `scoreGap` now **refuses to certify**
    without a catalog (`CHANNELS_UNVERIFIED`, blocking) and `builder.js` guarantees one.
    **Refusing to certify is always available; certifying without checking is not.**
  - **The check that was supposed to catch it was structurally incapable of failing.**
    `converger-adversarial.mjs` check 6 (*"complete ⇒ publishable"*) **scored with no capabilities
    and validated with no `channelRegistry`** — both sides equally blind, so the divergence was
    invisible **by construction**. Production validates *with* a registry. That is **architectural
    flaw #2, verbatim**: *a check that exercises a configuration production never uses cannot see the
    bug production has.* The generated sweep had even listed the exact line (`gap-scorer.js`
    `byId.get(id) ?? null`) as a **survivor**, and the builder read past it.
    **Rule: a check must construct its subject the way PRODUCTION constructs it. If your test hands
    in something production omits — or omits something production hands in — it is testing a program
    nobody runs.** `p3-converger-run.mjs` was fixed the same way: it drove the converger with no
    channel catalog at all.
  - **`BRANCH_CASE_NOT_IN_ENUM` (new).** A branch on a `classify` whose cases name values the
    classifier **cannot produce** (`"HIGH"` when the categories are `urgent|normal`) validated clean
    and scored complete. Every run takes the catch-all — silently, forever, with `run_completed` —
    while the converger reports the workflow finished. **We forced the domain closed precisely so
    membership would be DECIDABLE, and then never decided it.** Closing a domain and not checking
    against it is a completeness claim nobody made good on. `closedDomainOf()` is now the single
    definition of "what values can this node emit", shared by the allowlist and the case check, so
    the two cannot drift.
  - Also: `ratify` shipped a finished-looking draft with unresolved **blocking** gaps (the user found
    out on a failed save) — it now carries `publishable` + `blockers`; and the outcome-candidate
    filter silently dropped a requested connector (**defect #1 relocated from the spec into the
    candidate list**) — it now says what it refused to promise, and why.

- **The human approval gate (2026-07-13, P12 increment D)** — Increment B built the durable pause
  and stopped there **on purpose**: an approval anyone can forge is not an approval, so the
  authentication got its own increment and its own adversarial check. D is that half. A `human`
  node is now reachable: the ask goes out, the answer comes back **proven**, and an unanswered one
  never becomes a yes.
  - **`src/approvals/approval-store.js`** (new) — mirrors `password-reset-store.js`: 32 random bytes,
    **SHA-256 hash only** on disk, single-use, TTL from the node's own `timeout.after`. **One token
    per `(runId, nodeId, decision)`** — approve and reject are *different secrets*, so a forwarded
    "approve" link cannot be edited into a "reject"; and **consuming either burns both**, because a
    question that has been answered must not be answerable again by the next person down the thread.
    `issue()` **throws** without a tenant (a `?? 'default'` here would be a cross-tenant forgery
    primitive — the `?? 'unscoped'` lesson, fourth occurrence).
  - **`src/approvals/approval-service.js`** (new) — the ask, over every declared channel in parallel
    (first valid answer wins), and one `resolve*()` per channel. **Each proves who is answering
    BEFORE the engine sees it**: `inbox` an authenticated session whose tenant must match the run's;
    `slack` an HMAC-verified `block_actions` carrying the Slack user id; `email` a signed, hashed,
    single-use magic link. There is exactly ONE door into the engine (`scheduler.resumeRun`) and it
    authenticates nothing, by design. **A fifth channel proves its answerer before it reaches that
    door, or it is not a channel.**
  - **`GET /approvals/:token` DECIDES NOTHING.** It is a link in an email, and things that are not
    people fetch those: scanning proxies, link checkers, the mail client's own prefetcher. If the GET
    consumed the token, a corporate security appliance would approve the customer's refund
    milliseconds after the mail landed. The GET renders a page; a **POST** from it answers.
  - **`POST /connectors/slack/interactive` is a DIFFERENT URL from `/connectors/slack/events`**, and
    it needs its own body parser: Block Kit buttons arrive `application/x-www-form-urlencoded` with
    the payload in a `payload` field, and the global `express.json` leaves `req.body` empty — which
    would make the signature unverifiable. The tenant is resolved from the Slack **team id**, never
    from the button's `value`: a value is a routing hint, and a routing hint that could name a tenant
    is a cross-tenant forgery primitive.
  - Validator (§7.7): **`HUMAN_WITHOUT_TIMEOUT`** (a pause with no deadline never ends, never fails,
    and never tells anyone), **`HUMAN_BAD_TIMEOUT`** (a `then` outside the node's own answers takes a
    path nobody wrote — the `BRANCH_BAD_ON` class), **`WEAK_APPROVAL_FOR_WRITE`** (an emailed link
    proves possession of a mailbox and is forwardable; it may not stand alone in front of a send or a
    write), **`APPROVAL_CHANNEL_NOT_CONNECTED`**, **`EMAIL_REPLY_APPROVAL`** (§11.8 — `From:` is
    forgeable, SPF/DKIM authenticate a sending *domain* rather than a human *intent*, and a forwarded
    thread is full of the word "yes"). `src/workflows/approval-channels.js` is the **single** trust
    table, read by the validator, the gap scorer and the service, so they cannot drift.
  - **`complete ⇒ publishable` held only because the scorer FAILS CLOSED — and D moved the hole one
    door along.** `APPROVAL_CHANNEL_NOT_CONNECTED` needs an approval-channel view; without one the
    check silently does not run, so a pause asking over a Slack workspace nobody connected would
    score `complete` and then refuse to publish. That is the C blocker exactly. `scoreGap` now
    refuses to certify a spec containing a `human` node when it cannot see the channels, and
    `builder.js` builds the view from the LOCAL registry (so a network failure cannot knock it out).

  **Four live defects found while building it — three of them pre-existing:**
  1. **A FAILURE PATH WAS ALSO A SUCCESSOR.** `on_error: { then: 'route_to:handler' }` requires an
     edge `node → handler` (the validator *enforces* it), and `propagate()` lit **every** outgoing
     edge on success — including that one. **So the only shape the validator accepted was the shape
     that misfires:** the error handler ran on every healthy run, silently, with `run_completed`. A
     "this broke" Slack post every morning — and, the moment D landed, an approval gate meant only
     for failures pausing **every single run**. Pre-existing in B, behind its green suite.
  2. **The documented approval shape could not be built.** §7.1 has always said a branch routes on
     `{{approve_send.decision}}`. The engine's reference grammar accepted only `<id>` / `<id>.output`,
     so that spelling was rejected at publish — i.e. *every* approval gate an LLM writes would have
     bounced, on the increment's headline feature. `ON_REF` now accepts `.output | .decision`, and
     **only** those: a branch may read a field whose domain `closedDomainOf()` declares, and nothing
     else. Routing on `classify.confidence` would leave the case check validating a value nobody is
     routing on — the moat, through a new door.
  3. **`timeout` was not an answer the engine would accept.** `closedDomainOf()` has always declared
     it part of a human node's closed domain (so a branch may carry a `timeout` case), but
     `human.run()` threw on it — because before the sweeper existed nothing could produce one. The
     declared timeout path was unreachable. **An unanswered approval still never becomes an
     `approve`**: the sweeper resolves `timeout.then` only when it names one of the node's own
     answers, else `timeout`. Silence is not consent.
  4. **The Approve button sent no answer** — and only rendering the UI in a browser found it.
     `_H()` already sets `Content-Type`; the handler spread it **and** added a lowercase
     `'content-type'`, and the `Headers` constructor **appends** duplicate names rather than
     replacing them. The request went out as `content-type: application/json, application/json`,
     which `express.json()` does not recognise, so the body was never parsed and the click came back
     *"no answer given"* with the run still waiting. **Render the UI. The scripts passing and the
     server booting is not the same as a person being able to click the button.** (This was C's
     recorded residual, and it was worth exactly what it cost.)

  **`escalation.js` (new) — escalation finally MATERIALISES.** C made "escalate" the default
  resolution of every non-blocking gap, which is what makes *"Accept all defaults"* honest — and then
  emitted a spec in which nothing asked anybody anything. The promise was real at build time and
  empty at run time, which is the worst place for a promise to be empty: **the user has stopped
  worrying about it.** Now `NO_ERROR_PATH` → `on_error: {retry:2, then:'escalate'}` (a failure reaches
  the owner's Approvals list instead of a log nobody reads), and `CONDITIONAL_UNPROVEN` → a real
  `human` gate in front of the step, because the honest escalation of *"I cannot decide this"* is to
  **ask**. Anything else escalated is **reported as unmaterialised, by name, with the reason** — a
  gap we said we would escalate and then quietly did nothing about is a lie in the language of safety.

  **A `human` node ALONE IS NOT A GATE — it needs a `branch`.** Nothing stops the step after a
  `human` from running; `human` only *reports* the answer, exactly as `branch` only reports a route.
  So `draft → approve_send → send_email` — which is what converger-v2 §7.1's shape read like —
  **sends the email whether the person approved or rejected it.** It looks precisely like an approval
  gate and is precisely a no-op. §7.1 is corrected; `escalation.js` materialises the routed shape and
  `prompts.js` teaches it.

  **`scripts/` diffs — checks ADDED, never weakened** (a diff against `scripts/` is how a verifier
  detects a builder quietly weakening their own gate, so it must never be silent):
  - `scripts/gates/p12.sh` — **not modified.** D's block was written in advance and is the checklist.
  - `mutation-sweep.mjs` — `TARGETS` **widened** to `approval-store.js`, `approval-service.js` and
    **`workflow-scheduler.js`** (closing the round-9 residual, which asked exactly this once an
    increment touched the scheduler). `SUITES` gains the two approvals suites + a new
    `tests/workflows/scheduler.test.js`. **The floor was NOT lowered.**
  - **The widened sweep immediately earned its keep:** the scheduler — the choke point every real run
    passes through, and where the monthly-run **plan cap** is enforced — had **no unit tests at all**.
    `if (allowed === false)` (the cap itself) could be inverted with the whole suite green. It has a
    suite now.
  - **The Slack/email surface was covered ONLY by `approval-adversarial.mjs`, which the sweep does not
    run** (it runs `node:test` suites), so the sweep reported all of it as unkillable — correctly. **A
    mutant is only killable by a suite that EXECUTES it, and "some other script covers it" is exactly
    how a guard ends up pinned by nothing.** Hence `tests/approvals/approval-channels.test.js`.
  - `tests/workflows/control-flow.test.js` — **one FIXTURE changed, no assertion touched.** Its
    "positive: a well-formed human step validates" case had a `human` node with **no channels and no
    timeout**, which D makes an error. B could not have known: it had no way to deliver an ask, so
    "well formed" then meant only "has a prompt and two answers". The old fixture was not a
    well-formed human step; it was an *unanswerable* one that nothing had yet noticed. The invariant
    the test pins — **the good shape is ACCEPTED** — is untouched and still holds.

- **The verifier FAILED increment D, and the test-adversary corroborated it — 4 blockers, all behind a
  green suite (2026-07-13, round 2).** Same lesson as B and C, a fourth time: the headline invariant of
  the increment (*"a `human` node alone is not a gate; the step after it does not run on reject"*) was
  **false**, and it took an independent pair of eyes to see it. All four are now fixed and pinned by
  `tests/approvals/gate-adversarial.test.js` (in the gate + the sweep). **Three of the four were a
  LAUNDERING HOP one step to the left of a real check** — the exact shape CLAUDE.md names three times.
  1. **A `human` node ALONE IS NOT A GATE.** `draft → ask → send` (no branch reading the decision)
     validated clean, and on **reject the customer got the draft anyway**. `human` only REPORTS its
     answer (like `branch` reports a route); nothing stopped the next step. `escalation.js` and
     `prompts.js` both *asserted* "the validator will reject it if any is missing" — it did not. Fixed on
     **both sides** (the doctrine `BRANCH_TARGET_EXTRA_PARENT` follows): the validator rejects it
     (`HUMAN_ANSWER_NOT_ROUTED` — a human's successor must be a `branch` that routes on
     `{{<id>.decision}}`), and the **engine** lights only that gating branch, so a DB spec that predates
     the rule cannot deliver a rejected draft either (`flow-tester.js` propagate(), `isGateFor`).
  2. **`.decision` defeated the moat.** Increment D taught `BRANCH_BAD_ON` the `.decision` reference
     form and left **two other parsers** (`_checkDecisionInputs`, `BRANCH_CASE_NOT_IN_ENUM`) on the old
     `/\.output?$/` regex — so on the ONE shape §7.1 documents and `escalation.js` emits
     (`on: "{{ask.decision}}"`), the moat and the case-membership check silently `continue`d. A case
     `"approved"` (typo of `"approve"`) published clean, matched nothing, and the mandatory catch-all
     swallowed 100% of traffic. **All three parsers now use the shared `ON_REF`** — three parsers of one
     reference is three chances to disagree; there is one now.
  3. **Silence became consent.** `timeout: { then: 'approve' }` passed `HUMAN_BAD_TIMEOUT` (approve IS a
     declared answer) and the sweeper handed the engine `approve` with `by: 'system:timeout'` — nobody
     read the draft, the customer got it. `sweepTimeouts`'s own docblock swore *"It never resolves as
     `approve`."* Fixed **behaviorally, not by banning the word "approve"**: `timeoutAuthorizesWrite()`
     traces what the timeout decision would ACTUALLY do (follow the branch case to its subtree, ask if it
     writes), so it is exact for any decision vocabulary (`ship`/`hold`, not just `approve`/`reject`).
     The validator rejects it; the sweeper **downgrades to `timeout`** for DB specs that predate the rule.
     **A timeout may say DON'T (`reject`) or escalate — it may never perform the action the approval
     existed to gate.**
  4. **`WEAK_APPROVAL_FOR_WRITE` was laundered by a `foreach`.** `isWriteNode` checked `deliver` /
     writing `connector-action` but never looked inside `foreach.config.steps`, so an **email-only**
     (forwardable) approval in front of a loop of `airtable_create_record` was accepted while the
     identical single write was refused. A loop is N writes per fire — the highest-risk write shape the
     engine has, and the one place the rule was blind. `isWriteNode` now recurses into `foreach` steps.
  - **9 existing control-flow tests regressed on the B1 engine fix, and that was EXPECTED** (the
    adversary flagged it before I merged): those resume/fidelity fixtures used the now-invalid ungated
    `human → deliver` shape. **Fixtures updated to route through a branch; not one assertion touched** —
    the checkpoint-fidelity invariant (the SENT body equals the APPROVED draft) still holds, because a
    `branch` is a CONTROL node and does not launder `lastOutput`. A diff against `control-flow.test.js`
    shows only fixture graphs changing, which is how a verifier confirms the assertions were preserved.
  - **Residuals fixed in the same pass (the verifier classified them non-blocking; they were cheap and
    R1 was genuinely broken):** **R1** — the approval Slack post read `getSlackGrant(...)?.botToken`,
    which is **always undefined** (that function returns `{connected, scopes, account}`, no token), so a
    tenant's approval posted into the OPERATOR's Slack; now uses `getSlackToken({...cipher})` like
    `server.js:353`. **R2** — the raw magic-link token was written to the event-log path in plaintext,
    undoing the store's hash-only model; the logger now redacts `/approvals/<token>`. **R3** —
    `timeout.then: 'escalate'` routed to the catch-all but notified nobody (inert); the sweeper now
    calls the escalation notifier, so `escalate` is meaningfully different from a silent `timeout`.
  - **A FIFTH defect, on the verifier's re-check of the fix — silence-as-consent THROUGH THE
    CATCH-ALL, and it MOVES MONEY.** F3 fixed `then: 'approve'`, but the value the sweeper injects
    *most often* is the `timeout` floor (whenever `then` is unset), which routes through the branch's
    **mandatory catch-all**. An INVERTED gate — `cases:[{when:'reject',to:'drop'},{when:'*',to:'send'}]`
    with no `then` — validated clean, and on a silent timeout **SENT the refund with nobody having
    approved it**. Both guards structurally exempted `TIMEOUT_DECISION`, so the one decision the sweeper
    injects most was never traced. The verifier classified it a *residual* (the converger only emits the
    safe shape — `escalation.js` puts the non-write on the catch-all — so it is not generated-reachable)
    but recommended closing it because it moves money. **Closed, not merely recorded** — a money-moving
    violation of this increment's own "silence is not consent" invariant is not something to leave open
    behind a note. Fixed on both sides: the validator rejects a `human`-gate whose silence-injected
    decision routes to a write (`HUMAN_BAD_TIMEOUT`, the catch-all trace), and the **sweeper refuses to
    resume — it fails the run** when even `timeout` writes (no safe path exists). Pinned by
    `gate-adversarial.test.js` F5; both guards mutation-killed.
  - **The apparatus worked.** Every one of these reached a green-suite, browser-verified state and was
    caught only by the independent verifier + adversary running in parallel. `mutation-sweep` TARGETS
    now covers the validator, the scheduler, and the approvals; `gate-adversarial.test.js` is in both the
    gate and the sweep. **A green suite is evidence of nothing until a second pair of eyes has watched
    it go red.**

  **⚠️ OPERATIONAL HAZARD (HISTORICAL — the sweep was removed 2026-07-19; kept because the lesson
  generalises to any tool that rewrites `src/` in place): mutation-testing eats uncommitted work.**
  - `mutation-sweep.mjs` **rewrites files under `src/` in place** and restores them between mutants.
    Run in the background while you are editing, it will clobber your work — or, if it is killed
    mid-mutant, leave a **live mutant in your source tree** (`if (!fetcher)` → `if (false)`; a `throw`
    → `void 0 && …`). Run it in the FOREGROUND, and if it is ever interrupted,
    `grep -rn "if (true)\|if (false)\|void 0 && " src/` before doing anything else.
  - **A hand-rolled mutation loop that restores with `git checkout -- <file>` reverts to HEAD, NOT to
    your working tree.** If you have UNCOMMITTED edits in that file, `git checkout` **silently deletes
    them** — there is no stash, no reflog, no recovery except replaying the edits. This wiped an entire
    round of validator + engine fixes mid-session (recovered only because every edit was still in the
    agent's context). **COMMIT before you mutation-test, or restore with a saved copy
    (`cp f /tmp/f.bak` … `cp /tmp/f.bak f`), never `git checkout`.** The grep for mutant signatures is
    also your tell that a restore reverted too far: run it, and run the full suite, immediately after
    any mutation loop.

- **The `decision` node — the completeness proof, turned on (2026-07-14, P12 increment E)** — C built
  the DMN engine (`decision-analysis.js`: box subtraction, 10¹⁰ combinations in ~1 ms) and could not
  reach it from anything runnable: `decision` was not a registered node type, so **the moat guarded a
  shape no spec could contain**, and the analysis ran only in the converger — never at publish. E makes
  it real.
  - **`src/workflows/node-types/decision.js` (new)** — `inputs · output · hitPolicy · rules`, all under
    **`config`**. converger-v2 §2.2 drew them on the NODE, and **the engine cannot run that shape**:
    `run(cfg, ctx, services)` is handed `node.config` and nothing else, so a table hung off the node is
    a table the executor never sees — and one sitting outside `MISSING_CONFIG` / `UNKNOWN_CONFIG_KEY`,
    i.e. outside every check that makes a spec's shape true. `tableOf()` still **reads** the top-level
    spelling (so the moat and the analysis bite on it) and the validator **rejects** it. §2.2 corrected.
  - **AN UNCOVERED CASE THROWS.** It never returns null and never guesses. A null would reach the
    downstream `branch`, match no case, and be swallowed by the **mandatory catch-all** — a silent
    no-op with `run_completed`, which is verbatim the failure this phase exists to make impossible.
    That is why `DECISION_TABLE_GAP` can honestly be a **warning**: the escalation is real
    (`escalation.js` puts `on_error: {retry:1, then:'escalate'}` on the decision, so the throw reaches
    a person), and `complete ⇒ publishable` still holds because the gap scorer classifies by severity.
  - **ONE FEEL-A GRAMMAR.** `matchesCondition()` lives in `decision-analysis.js` beside the analysis
    and is built from the same `parseNumeric` / literal / `not()` code. A private copy inside the node's
    `run()` would be a second implementation of the rule language, and **the day they disagree the
    coverage proof describes a program nobody is running** — the analyser certifies every case is
    covered while the engine, reading the same table by different rules, matches nothing. Same doctrine
    as `outcome-oracle.js`. For the same reason the **DMN analysis moved into the validator**
    (`_checkDecisionTables`) and `gap-scorer.js`'s hand-rolled copy was **deleted**: publish and
    converge now consult one oracle, so the converger cannot ratify a table publish rejects.
  - **An unparseable condition is not "no match".** The engine **refuses to run** a rule it cannot
    read, rather than treating it as unmatched — which would silently narrow the table at run time
    while the analyser (which reports it as a bad condition) believed it was covered.
  - **`decision` is a CONTROL node** — added to `CONTROL_TYPES` (flow-tester) and `NON_CONTENT_TYPES`
    (`_node-input.js`), exactly as `branch`/`human` are. Its output is `{value, text, rule, inputs}` —
    the answer plus **which row fired** (the audit trail). Left out, a `deliver` after a decision sends
    the customer `{"value":"P1","rule":{…}}` instead of the draft. `text` is what a template renders,
    so `{{score.output}}` → `"P1"` rather than a JSON blob.
  - **A `branch` may NOT route on a `COLLECT` table** — it emits a *list*, and a branch matches by
    exact value, so nothing matches and the catch-all swallows 100% of traffic. `closedDomainOf()`
    returns `null` for one. Same class as `BRANCH_BAD_ON`, reached through the hit policy.
  - New validator codes: `DECISION_TABLE_GAP`, `UNIQUE_HIT_OVERLAP`, `DECISION_UNDECIDABLE`,
    `DECISION_BAD_CONDITION`, **`DECISION_OUTPUT_NOT_IN_ENUM`** (a rule's `then` outside `output.values`
    is a value nothing downstream has a case for — the `BRANCH_CASE_NOT_IN_ENUM` failure through the
    other door), **`DECISION_UNKNOWN_INPUT`** (a `when` on an undeclared key is **silently ignored** by
    the analysis, so the rule covers boxes its author believed it excluded — the proof would be about a
    different table), `DECISION_TOO_WIDE` (>4 inputs — **cognitive**, not computational: an unreviewable
    table is not auditable, which is the moat), `DECISION_BAD_HIT_POLICY` (an unrecognised policy is
    rejected, **never quietly read as FIRST** — that would run the table under a policy its author did
    not choose, and UNIQUE's promise would never be checked), `DUPLICATE_DECISION_INPUT`,
    `DECISION_BAD_INPUT_REF`.
  - **UI (`decision_review`)** — a TABLE, not prose: collapsed to one sentence by default, expanding to
    a grid whose cells are **dropdowns over the declared enum values** (a number gets a text box — its
    conditions are ranges, which no dropdown can enumerate), plus the hit policy as a plain-language
    radio (never the DMN letter). The dropdowns are only renderable *because* `LLM_INPUT_NOT_ENUM`
    forced the domain closed: the completeness proof is what makes the multiple-choice UI possible, and
    the multiple-choice UI is what makes the proof affordable to the user. Same asset (§13). The
    `decisions` graph node runs **before** `gaps`, so the gap list is about the table **as corrected**.
  - `mutation-sweep.mjs` — TARGETS **widened** to `node-types/decision.js` (the EXECUTOR that must
    agree with `decision-analysis.js`, which has been swept since C), SUITES gains the three decision
    suites. **Floor held at 0.78 — a ratchet, never lowered.** `scripts/gates/p12.sh` — E's block
    gained the three suites: the three checks it shipped with are a `grep` and an `ls`, which prove
    the SYMBOLS exist and not that anything enforces them (architectural flaw #1, verbatim).
    **Checks ADDED, never weakened.**

  **The verifier and the test-adversary found SIX live defects in E, three of them SILENT — and every
  one was behind a green suite (2026-07-14, round 2).** Fifth increment running. Pinned by
  `tests/workflows/decision-adversarial.test.js` (the six) and `decision-pinning.test.js` (the sweep's
  behavioural survivors); both are in the gate and the sweep.
  1. **A `decision` INSIDE A `foreach` DELIVERED THE DECIDED VALUE TO THE CUSTOMER, once per row.**
     `foreach.js`'s `CONTROL_SUBSTEP_TYPES` is a **second executor**, and `decision` was added to
     `flow-tester.js`'s `CONTROL_TYPES` and `_node-input.js`'s `NON_CONTENT_TYPES` and **not to it** —
     so the decision's `{value,text,rule}` became the iteration's `last` and `stringifyOutput` picked
     its `.text`: the channel received a plausible-looking `"P1"` instead of the lead, with
     `run_completed` and no error. **This is the THIRD time this exact line has been the defect** —
     CLAUDE.md's own increment-B block says "the sub-loop was missed at first" about `branch`, and it
     was missed again. **A new control type is not done until it is in BOTH sets.** Fixed on both
     sides (`CONTROL_SUBSTEP_TYPES` + a new `DECISION_IN_FOREACH`, mirroring `BRANCH_IN_FOREACH` — a
     decision in a loop is a structural no-op there anyway, because nothing inside a loop can route on
     its answer).
  2. **THE MOAT HAD A SECOND DOOR, and it was the one the deciding happens through.**
     `LLM_INPUT_NOT_ENUM` fires only on `evaluator:'llm'`. Declare an input `type:'enum'` with **no
     evaluator** and point its `from` at a *freeform* `llm`, and prose walked straight into the table:
     `coerce()` `String()`d it and handed it over, where it matched no rule but the catch-all. The
     workflow decided `P3` on an input reading *"This is EXTREMELY urgent — the server is on fire"*,
     and `analyzeTable` certified `decidable: true, uncovered: []` over it. **A false proof, with a
     receipt in the audit trail.** §11.7's property is *"the value being decided on has a CLOSED,
     DECLARED domain"* — **not "an LLM didn't type it"**. A value's domain is not bounded by who
     produced it, so the check belongs where the value **enters the table**, on every path in.
     `coerce()` now rejects an off-enum value (it throws → escalates → reaches a person, which is
     exactly what an unanticipated case must do). Same class as C's laundering hop: **a check scoped to
     the PRODUCER instead of the VALUE is wrong by construction.**
  3. **THE CLASSIFIER RETURNED THE VALUE THE MODEL NEGATED.** The off-enum fallback was *"the first
     declared value appearing ANYWHERE in the answer"* — so with `['approve','reject']`, the answer
     *"I would reject this — do not approve"* classified as **`approve`**, and the table decided on it
     with full confidence. It never returned free text; it returned **the wrong member of the set**,
     which is worse, because every downstream check passes. It also made any value that is a PREFIX of
     another (`ship` vs `ship_hold`) unreachable the moment the model added a preamble. Now: exact
     answer wins, else the answer must contain **exactly one** declared value on **word boundaries**;
     an ambiguous answer to a closed question is not an answer, so it throws. **The identical fallback
     was in `llm.js` mode `classify`** — the *other* sanctioned way an LLM feeds a decision (§11.7) —
     and is fixed with the same shared `pickCategory()`.
  4. **A `null` extracted field decided via the catch-all.** `llm` mode `extract` states in its own
     system prompt that *"if a field cannot be found, its value is null"* — so **the one producer the
     converger is taught to put in front of a table** emits precisely the value `readInput` did not
     catch (it checked `undefined` only), and a `null` matches only `-`. The table decided on a value
     nobody supplied — which `readInput`'s own docblock already forbade in those words.
  5. **A `from` the validator ACCEPTS must be one the engine can RESOLVE.** `from` is a REFERENCE, not
     a template, and `_runNode` was substituting it — so `from: "{{think.output}}"` arrived as the
     prose itself and the engine went hunting for a step named after it. **Verbatim the `branch.on`
     crash** (increment B), one increment later, in the one other place a reference lives. `inputs`
     now stay RAW, like `foreach.steps` and `branch.on`. (`<id>.output` also now means the step's
     output, the spelling every other reference in the system uses, instead of a field named "output".)
  6. **The engine and the analyser read one condition two ways.** `coveredAtoms` compared an enum
     literal **case-sensitively**; `matchesCondition` compares it **case-insensitively**. So
     `when: {tone: "URGENT"}` was a condition the engine evaluates happily and the analyser called
     *unreadable* — a hard publish error whose message ("isn't a condition this system can check") was
     simply untrue. This file's own header says the day the two halves disagree is the day the proof
     describes a program nobody is running. (Also: a comma list silently dropped its undeclared
     members, so `"urgent, bogus"` covered half of what its author wrote while the same typo *alone*
     was correctly an error. A rule is unreadable if ANY part of it is.)
  - **Two of the guards written in the FIX then SURVIVED the curated mutation-guard** — deletable with
    the whole suite still green. **Mutation-test the guards you add in the fix, not just the ones you
    started with.** Fifth occurrence of that exact lesson; it is now 35 curated mutations, all killed.

- **"Not exercised" is a VERDICT, not a pass and not a failure (2026-07-19, live UI test
  remediation).** Findings F11/F12/F16 from [`docs/handoff/ui-test-findings-2026-07-19.md`](docs/handoff/ui-test-findings-2026-07-19.md).
  - **The oracle certified the ABSENCE of evidence as success.** `contract.every(c => c.ok)`
    is true over an empty set *and* over a set that is entirely skips, and both rendered as
    *"every promise held — it's cleared to go live"* on the control that gates **Go live**.
    Three live shapes reached it: a spec with no assertions; an ordinary edit that cleared
    `outcome.examples` to 0; and a 3-lane router whose one sample took the do-nothing lane,
    so every assertion was `skipped:true, ok:true` and **no delivery node executed at all**.
    `evaluateExampleRun` now returns **`verdict`** (`kept | broken | not_exercised`) and
    **`enforced`** (assertions this run actually CHECKED — a skipped lane is not a check).
    Kept requires `enforced > 0`. The client certifies on `verdict`, with a new
    `testState:"unverified"` that leaves Go live locked (`reviewDraft` gates on `"passed"`).
  - **`contractPassed` was deliberately NOT changed, and that restraint is the fix.** The
    converger's `verify` node reads it to decide whether to REGENERATE. Resolving
    "unexercised" pessimistically there is exactly what threw away a valid 12-node draft
    and rebuilt it until the build gave up, then told the user *"I couldn't assemble the
    workflow from that"* (F17) — while the reasoning stream visibly concluded *"The
    workflow looks complete."* **The optimistic reading (false pass) and the pessimistic
    reading (false failure, expensive rebuild loop) are the two wrong answers to one
    question the system could not express.** So the fix ADDS the missing answer instead of
    flipping the sign of the existing one. Anyone tightening this further must keep them
    separate, or they will trade F12 for F17.
  - **The structural fallback survives only where there is no contract.** A spec that
    promises nothing has nothing to certify, so "it ran cleanly" stays the honest bar and
    v1 workflows publish unchanged. A spec that DOES promise something and proved none of
    it is `unverified`. **Refusing to certify is always available; certifying without
    checking is not** (same doctrine as `CHANNELS_UNVERIFIED`, third occurrence).
  - **THE CONTRACT WAS NEVER PERSISTED — and the brief's diagnosis of why was wrong.**
    `outcome` was NULL on 100% of stored workflows (148/148 on the pre-purge backup),
    including rows the builder had just displayed a contract for, silently disabling
    `UNSATISFIED_ASSERTION` on every later edit and leaving the SOP nothing to render. The
    handoff brief blamed the **POST** body; re-grounding showed that path is correct
    (`assembleSpec` emits `{version:2, outcome}`, and `{ ...spec }` carries it through).
    **The real cause is that POST is nearly unreachable:** `_ensureDraft` creates the draft
    row on the FIRST MESSAGE, so `S.workflowId` is always set and publish goes through
    **PUT** — which enumerated its fields and omitted `outcome`. `workflowService.update`
    correctly read the absent key as *inherit*, and inherited the draft row's `NULL`.
    Fixed by carrying `...(spec.outcome !== undefined ? { outcome: spec.outcome } : {})`,
    preserving `undefined`=inherit / `null`=retract.
    **A route that "updates an existing workflow" may in fact be your PUBLISH path — check
    which branch production actually takes before trusting either one's field list.** This
    is architectural flaw #2 in a new costume: the POST branch was correct, tested, and
    almost never executed.
  - **Reconciling beat believing, in both directions.** The brief's evidence (148/148 NULL)
    was sound and its mechanism was false. Trusting the mechanism would have "fixed" a
    correct handler and shipped the bug; trusting the fresh grounding alone would have
    closed a real, universal defect as a non-bug. CLAUDE.md's rule 4 ("believe the
    executing agent's fresh grounding") is about a brief's *conclusions* — it never
    licenses discarding a brief's *measurements*.

- **LANE COVERAGE — a router is only proved on the routes you test (2026-07-19, F16).** The
  per-example verdict cannot catch an unexercised lane, because each example is individually
  honest; it is a property of the SAMPLE SET. `laneCoverage` / `laneInventoryOf`
  (`outcome-oracle.js`) subtract the lanes any run actually took from every lane the spec
  has, and an uncovered lane BLOCKS certification and is named in the user's own case words.
  The live 3-lane router was certified "every promise held" on one sample that took the
  do-nothing lane and executed no delivery node at all.
  - **A lane is a `(branch, target)` pair — not a target, and not a route value.** Keyed on
    the target alone, two branches with a same-named target conflate and covering one
    silently marks the other covered (the approval shape has exactly two branches). Keyed
    per VALUE, a decision table mapping P2 and P3 to one "stay quiet" step would demand a
    sample per enum member — unreachable on the tables that most need it. **Found by
    mutation: dropping the branch from the key SURVIVED the first version of the suite,
    because every fixture in it had a single branch.**
  - **The lane a run took is read from the branch's OWN `{value, matched, to}` output.**
    Re-matching the routed value against the cases here would be a second implementation of
    `branch.run()`'s selection rule, and `decision-analysis.js` held one rule in two
    functions and diverged twice. A test asserts the engine's record wins even when it
    contradicts the classifier's output.
  - **The client holds no copy of the rule.** The lane inventory (what lanes exist and what
    to call them) ships with each example result; the browser does set subtraction only. A
    `_laneCoverage` helper in `public/index.html` would have been a second definition of
    "what is a lane" in a file nothing type-checks.
  - **`decision-analysis.js` box subtraction was considered and REJECTED as the primitive.**
    It answers a build-time question ("which input combinations do these rules fail to
    cover"), not the run-time one ("which lanes did the samples fail to exercise"). Forcing
    one to serve the other is the fit-forcing that CAUSES drift, not the cure for it. The
    genuinely shared primitives are `closedDomainOf` and `normalizeCases`, which the oracle,
    the validator's moat and the SOP already share.
  - **Never use an unprintable character as a separator — second occurrence.** `laneKey` was
    first written with `\u0001` between the ids. Same class as the NUL that made a whole
    feature unpublishable in increment B. It is `JSON.stringify([branch, to])` now: no
    collision is possible for any id, and it prints as itself in a debugger.

- **THE PRODUCT CERTIFIED A CASE IT HAD JUST DISPROVED (2026-07-21).** A generated sample set
  routinely carries a NEGATIVE example — *"Email without ATLASTEST in subject — should not
  trigger"*, `expect: null`. The test panel never fires the TRIGGER: it seeds the workflow with
  `given` and runs the steps. So the negative case ran like any other, **DELIVERED** like any
  other, satisfied the delivery assertion, and came back **`kept`** — a green tick reading *"should
  not trigger"* directly under *"every promise held"*, moments after a real Slack DM had gone out
  for that exact input. Confirmed against the live run table: the delivered body was the negative
  example's own data. **The one row a reader would take as proof the workflow stays quiet was proof
  of the opposite.**
  - Fixed in `evaluateExampleRun`: an example that explicitly declares `expect: null` is
    **`not_exercised`**, and carries `negative: true` so the panel can say *why* ("testing runs the
    steps directly without checking the trigger").
  - **Deliberately NOT `broken`.** The delivery happened because the harness bypassed the trigger,
    not because the spec is wrong; resolving that pessimistically is what throws a valid spec into a
    rebuild loop (F17). `not_exercised` neither certifies nor blocks, so the POSITIVE examples still
    carry the workflow to a pass — **pinned by a test, because a fix that quietly made every
    workflow with a negative sample unpublishable would be worse than the bug.**
  - Absent ≠ explicitly null: an example that merely omits `expect` is judged exactly as before.
  - **Residual:** the generated examples' `expect` now says `Date: <arrival date>` while their
    `given` carries only `from`/`subject`/`body` — no date. The live workflow therefore delivered
    `*Date:*` with nothing after it and the panel still said the contract held. The real trigger
    does supply a date, so production is likely fine; the EXAMPLE GENERATOR is what needs to put a
    field in `given` whenever the contract names it. (Increment G's recorded residual, now with a
    reproduction.)

- **A SCHEDULED RUN THAT DELIVERED "I COULDN'T DO MY JOB" WAS RECORDED AS SUCCESS (2026-07-21).**
  Every content `llm` node carries the guard the converger writes into it: if its input is missing,
  output EXACTLY `ERROR: required data not found`. The step does not THROW, so the string flows to
  the delivery and is sent verbatim, and the run is stored `success`.
  - **Found in production data, and it had formed a LOOP.** A daily briefing delivered the sentinel
    to its owner — and because it delivers INTO the same inbox it reads, the next run picked up its
    own error mail as input, produced the sentinel again, and sent it on. The run at 21:33:25
    delivered message `19f48ccd106eb4ba`; the run at 21:33:31 **fetched `19f48ccd106eb4ba`**. Every
    run in the loop is stored `success`, so the console's health score read **100%**.
  - **The TEST panel has gated on this sentinel since Increment G (`server.js` R14); the SCHEDULER
    never did — which is exactly backwards. A test run is watched by a person; a 5am run is not.**
    `runProducedContentError` is now exported from `outcome-oracle.js` and consulted at the
    scheduler's completion point, so the two paths cannot drift.
  - The match stays **deliberately exact** (`ERROR: required data not found`): a digest that merely
    reports somebody else's error must not fail the run. False alarms are how people learn to ignore
    the console. Pinned by a test and mutation-killed (detector disabled; match broadened to any
    `ERROR:`).
  - **NOT fixed — carried:** a workflow can still read its own output when it delivers into the
    inbox it reads. The loop now fails loudly instead of silently, but the cycle is still
    constructible. A generic fix (exclude mail this workflow itself sent) is the follow-up.

- **THE WORKFLOW DIAGRAM WAS UNREADABLE ON EVERY APPROVAL WORKFLOW — and the file already
  contained the fix (2026-07-21).** Opening a 16-node approval spec drew the FIRST step low
  and left, the steps AFTER the approval ABOVE it, and "Stop — rejected" above the step it is
  the alternative to. The eye had to read bottom-left → top-right → back down. The edges were
  all correct; the picture was not, and on a diagram that is the same failure.
  - **Cause: the live canvas was laid out BY HAND** (`_liveTrunkOf` / `_liveLanes` /
    `_liveFanout`) — a trunk, one lane per case of the FIRST split, and for any split *inside*
    a lane, merely a row break. Its own comment admitted the limit: *"a nested fork is expressed
    by the row break and the label, not by a second set of beziers… nesting it properly needs a
    real layout pass."*
  - **An approval workflow ALWAYS has a second split** — the branch that reads the person's
    answer is what makes the gate a gate. So the shape the product most needs to show was
    exactly the shape the renderer could not draw, and every sub-row restarted at the lane's
    LEFT EDGE, far left of the fork it descends from.
  - **The real layout pass was already in the file and already vendored.** `_layoutGraph` +
    dagre produced 13 clean left-to-right ranks on the same spec. **Two renderers for one
    thing is what caused this**, and the second one (`graphCanvas`, the dagre view-model) was
    computed on every render and had **no template at all** — dead code that nothing drew.
    The hand-rolled trunk/lane/fan renderer is now DELETED (~167 lines) rather than left
    beside the new one. `_laneSourceOf` / `_splitTargetsOf` / `_isExclusiveSplit` are kept —
    the step/path counter shares them, so the panel and the graph cannot disagree.
  - **What was deliberately PRESERVED, because each fixed a real defect:** cards still come
    from `_liveCardFor(node, i, …)` with `i` = the node's index in `liveNodes`, because **the
    approval queue walks that array BY INDEX and a node that never renders has no confirm
    control — the queue stops dead and the workflow can be neither tested nor published, with
    no error.** Laying out every node from that one array makes the coverage invariant
    structural instead of something a walk has to remember (the old renderer needed a
    `claimed` set plus a sweep). Verified live: 16 cards for 16 nodes, 4 for 4. The reveal
    animation is untouched (it lives in the card's own opacity/transform). Case labels still
    render and still **only** for an exclusive split — a parallel fan-out's targets all run,
    so labelling them claims a choice nobody makes (verified live on a 2-delivery fan-out:
    two curved edges, no labels).
  - **Edge keys are `JSON.stringify([from, to])`, never `from + '' + to`.** Concatenation
    cannot distinguish `("ab","c")` from `("a","bc")`, and a key that CAN collide is a
    silently dropped edge waiting to happen — third occurrence of this exact lesson (the NUL
    separator in increment B, then `laneKey`). **`_layoutGraph` still uses the concatenated
    form in two places** (its edge key and its `caseLabel` key) — carried, not fixed here.
  - **Width is the binding constraint, not height**, because the whole graph is scaled to fit
    the chat column: at ranksep 64 the spec came to 1566px, scaled to 0.70, and put the node
    titles at ~7px. Ranks are packed to just clear the 92px title (absolutely positioned, so
    it contributes no layout width) and the slack spent on vertical separation, which is free.
  - **VERIFIED ON A FRESH BUILD, not just on restored specs.** A 9-node, 3-lane email-triage
    workflow was built from scratch in a headed browser: the reveal ran, the graph drew
    left-to-right with the three lanes labelled *if urgent* / *if routine* / *else*, and the
    per-node approval queue was walked to **9 / 9 APPROVED** with **zero** confirm controls
    left over — including the nodes inside every lane, which is the case that would strand the
    queue. "Run test" then unlocked. That is the failure this renderer must never cause, so it
    is the one thing worth re-checking by hand after any change here.

- **NO WORKFLOW WITH AN APPROVAL STEP COULD BE PUBLISHED — one variable read too early
  (2026-07-21).** Press **Run test** on a spec with an approval step and the panel hung on
  "Testing…" forever: no timeout, no error, no escape but a reload, and Go live never unlocked.
  The engine was correct throughout — pausing at the gate is the deliberate design, and the server
  returned `paused:true` cleanly in ~1s per run.
  - **The cause was a temporal dead zone.** `_applyTestResult`'s `if (d.paused)` branch read
    `runDurationMs`, a **`const` declared ~40 lines below it in the same function**. Every paused
    run therefore threw `ReferenceError: Cannot access 'runDurationMs' before initialization` —
    **from inside the animation interval, after that interval had been cleared**, so nothing caught
    it and no `setState` ever landed. Fixed by hoisting the declaration to the top of the function.
  - **ONE UNCAUGHT THROW IN A STATE MACHINE PRESENTS AS FOUR UNRELATED COSMETIC BUGS.** The
    handoff filed the frozen timer, the contradictory body copy ("4 SAMPLES, NOT YET RUN" under a
    "Testing…" header), the overlapping pill and the hang as four findings. They are one. The timer
    froze at the instant of the throw; the body and the CTA kept their pre-run values because the
    state never moved. **Chasing them individually would have found none of them** — the tell was
    that they all stopped at the same moment.
  - **The written diagnosis was confidently wrong, and re-grounding is the only reason the right
    thing got fixed.** The brief said the single-run path *"already handles this properly"* and
    located the defect in the example loop. That path was in fact the broken one — it had simply
    never been exercised, because an approval workflow always carries worked examples. The loop
    defect it named was real but **secondary** (only the LAST example's data was carried forward,
    so a pause on an earlier example was silently dropped; first pause now wins). Fixing only what
    the brief described would have left the blocker exactly where it was. *(CLAUDE.md, rule 1:
    re-ground every brief against current code at the moment it is executed.)*
  - **A `grep` would have passed against the broken code.** The `d.paused` branch was present, the
    copy was written, the label existed — every symbol a check could look for was there, and the
    feature was totally dead. Pinned by `tests/api/test-panel-paused.test.js`, which **executes the
    real method source** against a paused payload (the file has no module boundary to import), and
    which was **watched go red** against the pre-fix file and restored from a `cp` backup.
  - **NOT fixed — carried:** the tester still cannot answer Approve/Reject in the panel, so the
    steps after the gate are exercised by no test. `testState: "paused"` correctly leaves Go live
    locked, so an approval workflow is now testable and honest but **not publishable through the
    panel**. Per `outcome-oracle.js` doctrine an unexercised promise must never certify — **do not
    make a paused run count as a pass to unblock publishing.**
    - **Update (2026-07-23): the answer-in-panel half was subsequently built** — `6ef6135`
      ("feat(test-panel): answer an approval step and test both routes") wired `_answerPause`, which
      renders in-panel Approve/Reject on a paused approval and POSTs `{resumeRunId, decision}` to
      resume the run. So "the tester cannot answer in the panel" is now STALE. What remains unverified:
      that the after-gate path then resolves and Go live unlocks — no QA run has clicked it through,
      because clicking Approve executes the REAL after-gate steps (real writes/sends). The
      never-certify-a-PAUSED-run rule above is unchanged and still correct.

- **THE 100s PROXY CEILING IS A SILENCE LIMIT, NOT A TIME LIMIT (2026-07-21).** An approval-gate
  build died `524` three times running, each death discarding the whole build and telling the user
  to start over from "+ New workflow".
  - **The evidence was already in the codebase and had been read past twice.** The reasoning stream
    (`GET /api/builder/sessions/:id/reasoning`) heartbeats every 15s (`builder.js`) and was observed
    in the event log at **`ms: 227214`, status 200** — 227 seconds through the same tunnel. So
    Cloudflare is not cutting LONG requests; it cuts SILENT ones. The build POST sent nothing at all
    until it finished. **A log line that contradicts your model of the failure is the finding.**
  - **`src/api/keep-alive.js` (new)** — the two long POSTs (`/api/builder/sessions` and
    `…/:threadId/respond`) now DRIP WHITESPACE while they work. Leading whitespace before a JSON body
    is insignificant (`JSON.parse` / `Response.json()` skip it), so the client is unchanged.
    **Verified live: the same build that died three times returned `respond.ok` with `heldOpen:true`
    at ~140s and produced the workflow.**
  - **The first drip is DELAYED 15s, and that delay is the safety property.** Writing commits the
    headers and locks the status at 200 — a later `res.status(500)` is silently ignored. Almost every
    response is fast and must keep its real status code, so an untouched fast path is proven by
    `heldOpen:false` in the log. Only a request already heading for a 524 is affected.
  - **Once committed, a failure travels in the BODY as `{error}` with a 200 — so BOTH client call
    sites now treat a body-level error as an error whatever the status says.** Status alone would
    read the failure as a successful build and hand `{error}` to the interrupt handler, which ignores
    an object with no `type`: the build would appear to hang forever. Same doctrine as
    `/workflows/run` returning application errors as 2xx (Known gotchas, 2026-06-18).
  - **The first test defined its OWN copy of `keepAlive`** — architectural flaw #2 verbatim, a test of
    a program nobody runs. It is a module now, imported by both. Four hand-mutations killed; **two
    initially SURVIVED** (the default window, because every test passed `after` explicitly; and the
    post-end guard, because `send()` always clears the timer). A mutation run also **timed out and left
    a live mutant in the tree** — restored from a `cp` backup, never `git checkout`.
  - **Residual:** a build still dies if the browser is closed or refreshed. Background jobs + polling
    remain the better long-term answer; this removes the ceiling, not the fragility.

- **AN APPROVAL ASKED OVER SLACK BY EMAIL REACHED NOBODY (2026-07-21).** `chat.postMessage` takes a
  channel id, a user id or `#name` — **never an email**. `postSlack` in `server.js` passed its target
  through raw, so a `human` node asked over `slack: charles@agntic.co` failed `channel_not_found` and
  **the run paused forever waiting for a question that was never sent** — while the identical email
  resolved fine for a `slack_dm` DELIVERY, which does look it up. The resolvers (`resolveUser` /
  `resolveChannel` / `makeSlackApi`) were private to `registerSlackChannel`, so the approval path
  could not reach them. Lifted to module scope **unchanged** and exported; `registerSlackChannel`
  rebinds them to its injected `fetchImpl` so test doubles still work. One definition — a second copy
  drifts, and the day it drifts is the day an approval reaches nobody.
  - **`prompts.js` was also under-selling the feature:** it never said what a Slack ask LOOKS like, so
    the builder told the operator *"the human node does NOT support interactive buttons"* and offered a
    reply-with-a-word alternative — which is the `EMAIL_REPLY_APPROVAL` anti-pattern in a new costume.
    Slack asks render real **Approve/Reject Block Kit buttons**, HMAC-verified (Increment D). The
    prompt now says so, and that a Slack target may be a channel, a user id, **or an email**.

- **THE CHAT DROPPED ITS OWN BUILD BUTTON, TWICE IN ONE SESSION (2026-07-21).** The documented
  prose-instead-of-JSON drift (Known gotchas, 2026-06-25) is mitigated by a format reminder, and it
  still happens: `chat.reply parsed:false`, so `ready_to_build` is unreadable, **the Build button never
  renders**, and the conversation dead-ends on a reply that reads like it is about to build. Once the
  prose was cut mid-sentence. The user's only escape is to type "build it".
  The recovery already existed for the tool-budget case (ask again with tools DISABLED and the format
  spelled out) and is now used here too — **ONCE** per request, with the partial prose withdrawn via
  the existing `reset` event so the retry replaces it rather than appending. The retry is a bonus and
  never a new way to fail: on any error it falls through and shows the original answer.

- **AN APPROVAL STEP'S QUESTION IS A MESSAGE, AND THE PROMISE CHECKER COULD NOT SEE IT
  (2026-07-21).** Found by driving a real build in the browser: an approval-gate workflow
  **could not be built at all** — the build ran past Cloudflare's 100-second ceiling and died
  `524` with nothing saved.
  - **The cause was a BIND, not slowness.** `process` backward-chains one `deliver` node per
    assertion (`nodeForAssertion` → `deliver_<connector>_<assertionId>`), so *"DM me asking to
    approve"* became a **plain delivery node**. But that message is the `human` node's own ask.
    `satisfiesAssertion` went through `nodeEffect()`, which returns `null` for `human` — so
    folding the ask into the approval step left the promise pointing at a node that no longer
    existed (`UNSATISFIED_ASSERTION`, **won't publish**), while keeping both **DMs the person
    twice**. The model correctly identified the trap and spent its entire budget negotiating it
    (*"deliver_slack_a1 is typed as a 'deliver' node in the contract, so I need to keep it
    separate"*). Every approval workflow was unbuildable-or-double-messaged, by construction.
  - **Fixed in `satisfiesAssertion`, NOT in `nodeEffect` — and that placement is the fix.**
    `nodeEffect` feeds `isWriteNode`, which is what decides whether a forwardable email approval
    may stand in front of a write (`WEAK_APPROVAL_FOR_WRITE`). Teaching it about `human` would
    make an approval step count as a write and **gate approvals behind approvals**. So the ask is
    recognised in the promise checker and nowhere else; `nodeEffect(human)` stays `null` and a
    test pins it.
  - **This WIDENS the go-live gate, so the narrowing is the load-bearing half.** Only `inbox` and
    `slack` asks can keep a promise: an `email` ask is a signed magic link from the **platform
    mailer**, not the tenant's Gmail connector, so letting it satisfy `gmail:…` would claim a send
    nobody made. Each channel matches **whole** — its own connector against its **own** target —
    because pooling targets lets a locator-free `inbox` ask wave through a promise about a Slack
    channel the spec never posts to.
  - **A GREEN TEST PROVED NOTHING UNTIL IT WAS MUTATED.** The first "channels match WHOLE" test
    paired `slack` with `email` and **passed against a deliberately pooled implementation** —
    `email` is dropped *before* the match runs, so the test never exercised the property it was
    named after. Re-written to pair `inbox` with `slack` (both survive filtering), and the mutant
    then died. Four hand-mutations, all killed: kind-check deleted, email-as-gmail, pooled
    locators, empty-target accepted. **Nth occurrence of the same lesson — verify the mutation
    APPLIED (`diff`), then verify it FAILS.**
  - `prompts.js` — the whole-spec prompt said *"ALREADY DERIVED (reuse these exact ids … do not
    contradict them)"*, which is what made the placeholder feel binding. It now states a derived
    `deliver` is a **placeholder for a promise** that may be replaced by a step keeping the same
    promise, and that the approval step's own ask keeps the question-promise — delete the
    placeholder rather than message twice. **The bind is removed deterministically by the oracle;
    avoiding the second DM is prompt-level and therefore model-dependent.** A deterministic repair
    pass is the honest follow-up.
  - **Residual, NOT fixed:** builds still hold one long HTTP request open, so any build over ~100s
    dies at the proxy with everything lost and the user told to start over. This fix removes the
    largest known time sink; it does not raise the ceiling. Background builds + polling is the
    real cure.

- **Multiple destinations — a delivery's return value is a RECEIPT, not the work product
  (2026-07-14).** Surfaced by a load-bearing test and reported as *"the workflow only did the Slack
  send"*. The report's premise was wrong in an instructive way, and re-grounding it before writing the
  brief is the only reason the right thing got fixed:
  - **The engine DOES fan out.** One `deliver` per destination, each edged from the content step; both
    run. That was never broken, and `prompts.js` has always taught it.
  - **What broke is what the SECOND destination received.** `deliver` was in `_node-input.js`'s
    `NON_CONTENT_TYPES` (so an `llm` never ingests a receipt) but **not** in `flow-tester.js`'s
    `CONTROL_TYPES`, which is the set that governs `lastOutput`. So the first delivery's receipt
    (`{delivered, ts}`) became `lastOutput`, and the second `deliver` — which builds its body from
    `ctx.lastOutput` — **shipped the first one's receipt to the customer**: Slack got the summary,
    Gmail got `{"delivered":true,"ts":"…"}`. With `run_completed`, no error, and the run marked
    success. From outside it looks exactly like *"only the Slack one worked"*.
  - **It also means `run.output` has been the last channel's receipt all along** — which is what the
    console shows, what the Inbox stores, and what `output-validator.js` inspects for an empty body or
    a leaked template. Those checks have been reading the wrong thing; `EMPTY_BODY` could never fire
    correctly. Fixing `lastOutput` fixes them by construction.
  - Fix: **`deliver` joins `CONTROL_TYPES`** — fourth member, same class as `branch`/`human`/`decision`.
    The receipt is not deleted, it is simply not the work product: the deliver node's own
    `step_completed` still carries the `ts`, which is what the **P3 gate** reads to prove runnability
    (it reads `step_completed`, not `run_completed` — checked before touching it).
  - `tests/workflows/fan-out.test.js` (new, in the gate + both mutation lists) **asserts what each
    destination RECEIVED**, not that a delivery ran — a test that only checks "two deliveries happened"
    passes on the broken engine. The defect is *asymmetric* (destination #1 is always fine), so the
    suite also runs the edges in the reverse order and with three destinations.
  - **The other half of the original report — the converger DROPPING a requested destination — is
    Increment C's defect #1 and is already closed** (`UNSATISFIED_ASSERTION`: a spec that promises
    email and doesn't send it does not publish). Pinned by the same new suite so it cannot come back.

- **Schema-aware connectors + the example picker (2026-07-14, P12 increment F)** — the write story
  died at *"paste your Airtable base ID"*. F reads the destination instead of asking for it.
  - **The last OPEN config hole is closed.** `connector-action` was the only node type on
    `configPolicy: 'open'` — its params passed straight to the handler unchecked, so a hallucinated
    `tableName` (Airtable's REST API really has one) shipped, the handler ignored it, and the record
    went nowhere the user intended. Nothing needed inventing: **every capability already declared a
    `configSchema`** and it was simply never consulted. The key set is now the node's own keys ∪ the
    SELECTED CAPABILITY's params, resolved by the same function `deliver` uses — so they cannot
    disagree about whether `baseId` is real. Plus `UNKNOWN_CONNECTOR_ACTION` (an action id that does
    not exist was a 6am run-time throw) and **required capability params** (an
    `airtable_create_record` with no `baseId` cannot run, and used to publish clean).
  - **The check SKIPS when the capability cannot be resolved** (no registry ⇒ its key set is
    UNKNOWABLE, and an unknowable key set is not a wrong one). That is safe only because the **gap
    scorer fails closed** there (`CHANNELS_UNVERIFIED`). Skipping where it cannot run and failing
    closed where it cannot check is what keeps `complete ⇒ publishable` true.
  - **New capabilities:** `airtable_list_bases`, `airtable_describe_base` (field names, types, and a
    select's closed `choices` — a decision table can take its enum straight from the system of
    record), `sheets_describe` (tabs + header rows). **The `schema.bases:read` scope has been
    requested since the Airtable connector shipped and used by NOTHING** — every tenant who connected
    Airtable already consented, so this needed no re-auth and no migration. The door was built and
    nobody opened it.
  - **`{{step.field}}` — sub-field templates (ENGINE + VALIDATOR).** Without them there was **no
    correct way to write a record at all**: an Airtable record is a map of column → value, each value
    from a different part of the upstream extract, and with only `{{extract.output}}` the sole
    expressible spec put the **whole JSON blob into every column**. The only way to write real
    per-column values was a JSON-STRING `fields`, which let a model choose the column names at RUN
    time — where **Airtable silently discards the ones that do not exist**. So the grammar was widened
    and `UNCHECKABLE_WRITE_FIELDS` now refuses the uncheckable shape. *(This is why the "dotted
    sub-fields are not supported" gotcha below is now corrected rather than deleted.)*
  - **A WORKFLOW NEED NOT DELIVER.** `MISSING_DELIVER` counted `type === 'deliver'` and nothing else,
    so *"inbound email → extract → create the record"* was rejected unless a pointless delivery was
    bolted on. **The record IS the outcome.** Same failure as the five-item checklist that made the
    converger invent an LLM step for a two-step workflow (defect #4). The rule is now "the workflow
    has an EFFECT", answered by `isWriteNode` — which already recurses into `foreach`. *(Raised by the
    operator. It also killed the reasoning that made gap-scorer's `routed` filter an "equivalent"
    mutant: a write-only workflow has no `deliver`, so the connector-action arm of it is load-bearing.)*

  **The review pair found NINE defects in F, and BOTH headline features were broken (round 2).**
  1. **THE EXAMPLE PICKER NEVER RAN — in any session.** `examples` was the SECOND node in the graph
     and `propose` is the only node that ever put a trigger in the draft, so `fetchRealExamples` read
     `triggers: []` **every single time** and fell back to modelled cases **always**. "No typed
     example" never once happened. Fixed by deriving the trigger in `process` (a trigger IS part of
     the graph it backward-chains) and running `examples` after it. **converger-v2 §2.1's order
     (outcome → examples → process) is corrected to outcome → process → examples.**
  2. **WHEN THE COLUMN MAPPING WORKED, THE SPEC COULD NOT BE SAVED.** `destinations` rewrote the
     NODE's columns and nothing rewrote `outcome.assertions[].fields` — so the node wrote `Deal Size`,
     the contract still demanded `Budget`, and `UNSATISFIED_ASSERTION` blocked publish. **`complete ⇒
     publishable` was FALSE precisely when the increment did its job** — the C blocker, reintroduced
     by F's own headline feature. The mapper now returns a **rename map** and the contract is restated
     in the table's own words. A promise with no real column is **not deleted** — it stays, fails
     loudly, and the user is told which column their table lacks.
  3. **A `foreach` LAUNDERED EVERY CHECK F ADDED.** The validator's loop walks `spec.nodes`; a loop's
     steps live in `config.steps`. A connector-action inside a loop took a nonexistent action id, a
     hallucinated param, a missing `tableId` and the dead `model` key — and validated **clean**.
     **Newly reachable because F's own prompt teaches `foreach` for the first time**, with the example
     *"create a record for every row"* — precisely the node whose params F had just started checking.
     **Fourth time this exact laundering hop has been the defect.** Fixed with `_checkNodeConfig` —
     ONE method, called for a top-level node and a sub-step alike. **A check on a node's config is a
     check on EVERY node's config, wherever the node lives.**
  4. The **outcome oracle was blind inside a `foreach`**, so the shape F *teaches* could not satisfy
     its own `record_exists` assertion and could not publish. A loop is not an opaque box; it is N
     copies of what is inside it.
  5. **`isResolvedId` accepted a plausible hallucination.** An LLM asked for an id it cannot know does
     not emit `appXXXXXXXXXXXXXX` — it emits `appABCDEFGHIJKLMN`, which passes any shape test. And the
     whole `destinations` node was gated on that test, so **one guess skipped the base lookup, the
     table lookup AND the column mapping.** A shape test cannot answer this; **only the LIST can**.
  6. **A TOTAL column mismatch shipped verbatim** while a partial one was corrected — the worst case
     took the only path with no defence, which is the shape of every defect in this phase.
  7. **Every gap arrived with an EMPTY BOX.** `buildGapPrompt` listed gaps as "1., 2." and then asked
     the model to answer keyed by `gapId` — a string it had never been shown. So no suggestion could
     ever be matched, the paid call was discarded, and **a blocking gap was never routed back through
     the propose loop**: "Accept all defaults" could not resolve a blocker. The one surface that makes
     v2's extra rigour affordable was inert. *(Pre-existing since C.)*
  8. **Three Slack schemas lied about REQUIREDNESS** (`slack_file.content`, `slack_topic.topic`,
     `slack_reminder.text` all default from the upstream body), so F's new required-param check
     **rejected shapes that run perfectly** — "summarize the thread and upload it as a file" stopped
     publishing. **A schema that lies about requiredness rejects real workflows**: the Increment C
     failure through a new door. Fixed in the SCHEMAS, not the check.
  9. A **TRIGGER capability passed as an action id** (`gmail_new_message` has no handler — existing ≠
     runnable), and **`tests/helpers/catalog.js` omitted `in_app`**, the DEFAULT delivery channel, so
     every suite using it was blind to the commonest delivery in the product — flaw #2 living inside
     the helper written to fix flaw #2.
  - **The flagship's own fixture was wrong, and green.** `write-shaped.test.js` wrote
    `{{extract.output}}` into every column — the whole JSON blob in each — and passed, because it
    asserted the KEY was right and **never looked at the VALUE**. That is the "assert what it SENT,
    not that it ran" lesson, sitting in the acceptance test for the increment whose entire purpose is
    that defect.
  - `mutation-sweep` TARGETS **widened to `src/converger/elicitation-graph.js`** — the destination
    resolution, the column mapping and the example picker: **F by line count, and its mutation score
    was "NOT MEASURED".** Four of the nine defects lived there. **A file the sweep does not target is
    a file whose absence from the survivor list proves nothing.** 49 curated mutations, all killed.

- **The zero-typing path + the test-panel oracle + the SOP (2026-07-14, P12 increment G)** — G closes
  the phase with three deliverables: (1) the **test panel is a live outcome oracle** — "Run test"
  loops `outcome.examples` through the real engine and, per example, GATES on the machine-checkable
  contract (`outcome.assertions`) while SHOWING the freeform `expect` beside what the run produced
  ("show, don't gate" — a workflow-agnostic judge cannot truthfully check an SME's own words). (2) the
  **SOP carries** the outcome contract, the escalation policy (derived from the spec's own
  `on_error`/`human`/catch-all structure, so it is true even for a hand-edited workflow), and the
  provenance ("how this was decided"). (3) the **zero-typing path** — every interrupt carries a
  pre-selected default and the default for every unknown is "escalate to a person", so a
  provably-complete workflow publishes having answered NOTHING (`tests/e2e/zero-typing-build.test.js`,
  real model, in the gate).
  - **THE RUNTIME ORACLE ONLY WORKED FOR SLACK — found by driving the real UI (2026-07-14).** The
    test panel reported **PROMISE BROKEN on a workflow whose delivery SUCCEEDED**: an inbox summary was
    saved, the chat's own summary said "the message did reach your destination channel", and the oracle
    said "nothing reached inbox". Root cause: the runtime oracle (`deliveryConnector`) reads a
    delivery's connector from `delivery.channel`, but **delivery handlers are inconsistent about what
    they return** — Slack stamps `{delivered:true, channel:'slack'}`, **inbox omits `channel`**
    (`src/inbox/index.js:63`), and **gmail_send / airtable_create omit BOTH `channel` and `delivered`**
    (so `server.js`'s `.filter(o=>o.delivered)` dropped them before the oracle ever saw them). So every
    delivery target EXCEPT Slack — inbox is the *default* — showed a false PROMISE BROKEN on a correct
    run. **This is CLAUDE.md flaw #2 verbatim:** the 14 unit tests hand-built synthetic deliveries that
    all carried `{delivered, channel, target}`; NO handler but Slack returns that shape, so the suite
    was green while the feature confirmed only Slack.
  - **The fix assembles deliveries from the delivering NODE, not the handler's return.** New
    `normalizeDelivery(node, output)` + `isDeliveryNode(node)` in `outcome-oracle.js`: the channel comes
    from the node (`deliver`→`config.channel`, `connector-action`→`config.action`) and the destination
    from the channel's own locator keys read off the output or the node config — the one place they are
    always present. `server.js`'s `/workflows/run` now builds `deliveries` through this, keyed on
    `isDeliveryNode` (a `deliver` node, or a `connector-action` that WRITES per `nodeEffect`), so
    gmail/airtable are no longer dropped for lacking `delivered`. Verified end-to-end through the live
    authenticated server: a successful inbox run now returns `outcomeCheck.contractPassed:true`
    (`inbox_deliver → Support Email Summary`). Pinned by a new block in `example-oracle.test.js` that
    feeds `normalizeDelivery` the **EXACT object each handler returns** (source line cited), closing the
    synthetic-shape hole. 609 workflow/converger/approvals tests green.
  - **RESIDUAL — a trigger-fed `llm` node's generated examples can be too thin to clear its own guard.**
    The converger writes a guard clause into a summarize node's instructions ("If the provided email
    data is empty or missing, output EXACTLY: ERROR: required data not found", `prompts.js:203`). With
    a substantive email in the example's `given` the node summarizes correctly (proven); but the
    auto-generated worked examples for an email-triggered summarize carried a `given` the model read as
    "missing", so the guard fired and the test panel showed a false red. The oracle was CORRECT (it
    reported a genuinely failed run); the defect is upstream in **example-generation quality** — a
    trigger-fed node's `given` must be a realistic sample event, not a label. Follow-up for the
    converger's example generator; not an oracle bug.
