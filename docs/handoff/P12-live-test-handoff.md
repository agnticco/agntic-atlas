# Handoff — Live UI E2E testing of Converger v2 (P12)

You are a **live-driving test agent**. Your job: drive the real Atlas builder UI in a
**visible, foregrounded Chrome window** and build **several complete workflows end to
end** through the conversational converger (v2), running each in the test panel, to
shake out defects in the P12 "converger v2" build. You do NOT write feature code —
you find and precisely report defects (with evidence), and may propose fixes.

---

## 0. Ground rules (non-negotiable)

- **Every UI interaction happens in a HEADED, foregrounded browser the operator can
  watch.** Never headless, never a background tab. **Narrate each step before the tool
  call** ("clicking Build it", "picking the inbox outcome") and **save every screenshot
  to disk** so frames land in the conversation. "The scripts pass" ≠ "a person saw the
  button work."
- **Re-ground before you claim a bug.** No "X is broken" without a file:line or the exact
  request/response that proves it. Distinguish a real product defect from environment
  noise (a stale server, a thin generated example, an unconnected connector).
- **A fix is not verified until the server was RESTARTED after the fix hit disk.** The dev
  server does not auto-reload. Check process start time vs. edited-file mtime before
  trusting any result.
- **Live delivery is authorized to the OPERATOR'S OWN connected Slack/Google/Airtable only**
  (they've okayed real sends for E2E). Standard prohibited-action rules apply to any third
  party.

## 1. Setup

- Repo: `/Users/crepps/Desktop/atlas`. **Test against `main`** — P12 converger v2 (A–G) plus
  the two fixes below are merged there and **live in prod at v1.5.0** (2026-07-14). Open a
  **new branch** for any test-only artifacts.
- **⚠️ P12 is NOT gate-closed** — there is no `Gate: P12` ledger entry, by design: it shipped
  ahead of a passing gate at the operator's direction. `scripts/gates/p12.sh` currently fails
  on the mutation sweep (76.2% < 78% floor) — a **test-coverage gap** (G's `example-oracle`
  suite was never wired into `mutation-sweep.mjs`'s SUITES), **not a functional defect**. See
  CLAUDE.md's P12 status block for the fix-to-close. So don't expect a green gate, and don't
  read "no Gate trailer" as "not built".
- Start the local server via `npm start` (loads `.env`; `buildLLM` needs `ANTHROPIC_API_KEY`
  or it silently falls back to a local model). Confirm `curl -s localhost:3000/health` shows
  `llm: ready` and the expected version.
- The operator is logged in locally as **Charles / charles@agntic.co** (tenant `agntic`).
  Local sqlite DBs live under `memory/`. Inbox is the default, always-reachable delivery.
- Event log for "where did a run break": `memory/logs/atlas-events.log` (JSON lines —
  `run.start`/`run.step`/`run.ok`/`run.failed`).

## 2. What Converger v2 (P12) IS — so you know what to test

The converger turns a vague intent into a runnable JSON spec through dialogue, then the
existing engine runs it. v2 (increments A–G) added an **outcome contract**, BPMN/DMN
control flow, a human approval gate, and a zero-typing path. Node library is now:

`trigger · llm(mode: summarize|extract|rewrite|classify|freeform) · assemble ·
connector-action · search_web · deliver`  +  control-flow: `branch · foreach · human ·
decision`. (`tool`/`mcp_tool`/`fetch`/`summarize`/`extract`/`rewrite`/`daily_digest` no
longer exist; old specs are lifted on read by `compat-v1.js`.)

**What landed, increment by increment (test each surface):**

- **A — validator hardening + node re-cut.** `UNKNOWN_CONFIG_KEY` (an undeclared config key
  is a hard error), `REMOVED_NODE_TYPE`, `UNKNOWN_LLM_MODE`. Watch: a spec with a
  hallucinated key (`llm.model`) must be rejected, not silently dropped.
- **B — engine control flow.** `branch` / `foreach` / `human`, plus node-level `on_error`
  (retry + escalate/route_to) and `idempotency`. Liveness is tracked on EDGES; a durable
  pause emits a full-fidelity `checkpoint` (NOT the display-shrunk steps). Watch: a paused
  run resumes with the EXACT drafted content (not a 2000-char-truncated copy); control-node
  output (`branch`/`human`/`decision`/`deliver`) never becomes the delivered body.
- **C — the outcome contract (THE MOAT).** Every spec carries `outcome{statement,
  assertions[], examples[]}`. A spec that doesn't deliver on its own contract **does not
  publish** (`UNSATISFIED_ASSERTION`). Assertion kinds are a CLOSED set: `message_sent`,
  `record_exists`, `document_exists`, each targeting `<connector>:<locator>`.
  `complete ⇒ publishable` must hold. **`LLM_INPUT_NOT_ENUM`**: a `branch` may only route on
  a CLOSED, DECLARED domain (`llm+classify`, `decision`, `human`), never free LLM prose —
  else the mandatory catch-all silently swallows 100% of traffic.
- **D — the human approval gate.** A `human` node pauses; the ask goes out over
  inbox/Slack/email and the answer comes back PROVEN (authenticated session / HMAC Slack /
  signed single-use magic link). `EMAIL_REPLY_APPROVAL` is forbidden (a `From:` header
  authenticates nothing). A `human` node ALONE is not a gate — it must be followed by a
  `branch` routing on `{{<id>.decision}}`, or the next step runs on reject.
- **E — the `decision` node + DMN gap analysis.** A decision table (`inputs · output ·
  hitPolicy · rules`) whose coverage is PROVEN; an uncovered case THROWS (never silently
  routes to catch-all). Table review UI = dropdowns over the declared enums. Watch:
  off-enum values rejected; unparseable conditions refuse to run.
- **F — schema-aware connectors + example picker + `foreach`.** `connector-action` params
  validated against the selected capability's `configSchema` (no more `configPolicy:open`).
  Airtable/Sheets schema reads (`airtable_list_bases`, `describe_base`, `sheets_describe`).
  `{{step.field}}` sub-field templates. A workflow NEED NOT deliver (a record IS the outcome).
- **G — zero-typing path + test-panel oracle + SOP.** "Run test" loops `outcome.examples`
  through the REAL engine and, per example, GATES on the machine-checkable contract while
  SHOWING the freeform `expect` beside what the run produced ("show, don't gate"). Every
  interrupt carries a pre-selected default; the default for every unknown is "escalate to a
  person", so a provably-complete workflow publishes having answered NOTHING ("Accept all
  defaults"). SOP carries outcome + escalation policy + provenance.

## 3. TWO fixes landed 2026-07-14 during live driving — verify they hold

1. **Runtime oracle only worked for Slack (FIXED, `93e00f5`).** The test panel's "did it
   deliver on its promises?" oracle read a delivery's connector from `delivery.channel`, but
   only Slack's handler returns that field — **inbox omits it, gmail_send/airtable_create
   omit both `channel` and `delivered`**. So every target except Slack showed a **false
   PROMISE BROKEN on a correct run**. Fix: `normalizeDelivery`/`isDeliveryNode` in
   `outcome-oracle.js` assemble deliveries from the delivering NODE, not the handler output;
   `server.js` `/workflows/run` uses them. **← TEST THIS HARD: run workflows delivering to
   inbox, Slack, Gmail, Airtable, Sheets and confirm CONTRACT KEPT on a genuinely successful
   run for EACH.** This is the single most important regression surface.
2. **Generated examples had a `given` too thin to clear a trigger-fed node's guard (FIXED,
   `938564f`).** `buildExamplesPrompt` didn't tell the model the trigger's event shape, so
   for an email workflow it put the email in `expect` and left `given` thin — summarize then
   read its own guard clause ("email empty/missing → ERROR") and the panel showed a false
   red. Fix: the examples prompt is now trigger-aware (email trigger ⇒ concrete
   `{from, subject, body}` in `given`). **← Confirm generated examples for email triggers
   carry real emails, and the test panel goes green.**

## 4. The finding that motivated this handoff — WATCH IT

**Delivery nodes are auto-derived from the outcome contract, NOT proposed as a confirmable
step.** In the build conversation, the converger explicitly proposes/confirms the *name* and
each *processing* (`llm`) node — but the `deliver` node is DERIVED from `outcome.assertions`
in the `process` graph node (`nodeForAssertion`) and only appears in the test panel /
"See the draft", never as a per-node confirm gate. Implication: if the derived delivery node
has the wrong channel, subject, or config, the user has NO conversational step to catch it —
and this is exactly the surface where the Slack-only oracle bug lived. **For every workflow
you build, open "See the draft" and verify the derived `deliver` / write `connector-action`
node has the correct channel, target/locator, and config for the destination the outcome
named.** Report any mismatch between the outcome statement and the derived node.

## 5. Test matrix — build these end-to-end, in the UI, and RUN each

Aim for coverage of every delivery target and every control-flow type. For each: build via
chat → "Accept all defaults" where offered → Run test → read the per-example oracle cards →
open "See the draft" → confirm the derived nodes. Save screenshots throughout.

1. **Email → summarize → INBOX** (the default target; the fixed oracle path).
2. **Email → summarize → SLACK** channel or DM (the one that always worked — regression).
3. **Email → extract → AIRTABLE create_record** (schema-aware; `{{extract.field}}` columns;
   confirm the derived write node + that record_exists is confirmed on a real create).
4. **Email → summarize → GMAIL send** (gmail_send returns `{messageId,threadId}` — the fixed
   drop path).
5. **Trigger → summarize → GOOGLE SHEETS append / DOC create** (record_exists / document_exists).
6. **Multiple destinations** — one intent that delivers to TWO places (e.g. Slack + inbox):
   confirm BOTH receive the actual content, not a delivery receipt (fan-out; the receipt-as-
   body class of bug).
7. **A DECISION workflow** — an intent with a judgement over a number/several inputs
   ("route by deal size / priority"): confirm a `decision` table is induced, the review UI
   shows dropdowns over declared enums, coverage is complete, and a `branch` routes on it.
8. **A CLASSIFY → BRANCH workflow** — a one-input judgement over a closed category set.
9. **A HUMAN approval gate** — an intent that should pause for approval before a send/write:
   confirm the `human` node is followed by a gating `branch`, the ask renders, and reject
   does NOT perform the gated action. (Approval channels: inbox is always available.)
10. **A `foreach`** — "for every row / every matching email, create a record": confirm the
    loop's sub-steps honor idempotency and the derived write is correct per item.
11. **A zero-typing build** — answer NOTHING but defaults/clicks; confirm it reaches a
    PUBLISHABLE draft ("safe to publish") with escalation defaults.

## 6. What GREEN looks like vs. FAILURE signatures

- **Green:** test panel "All steps passed"; each example card **CONTRACT KEPT ✓** with a real
  `<channel> → <locator>` detail; the delivered content is the actual work product (open the
  Atlas inbox / the destination to confirm); "safe to publish".
- **Failure signatures to hunt:** "PROMISE BROKEN / nothing reached X" on a run whose delivery
  actually succeeded (oracle regression); a delivered body that is a JSON receipt
  `{"delivered":true,...}` or a control-node blob `{"decision":"approve"...}` or `…(truncated)`;
  a `branch` where every input hits the catch-all (silent misroute, `run_completed` with no
  error); a decision table that publishes with an uncovered case; a `human` gate that sends on
  reject; a spec that scores "complete" in chat but fails to save (`complete ⇒ publishable`
  violation); a derived delivery node whose channel/locator doesn't match the outcome statement.

## 7. Known residuals — do NOT re-report as new (from CLAUDE.md's P12 ledger)

- `nodeEffect`'s write-verb regex matches `..._message` (so `gmail_get_message` reads as a
  write) — pre-existing looseness, affects build-time too.
- `{{item.naem}}` typos inside a `foreach`, and `{{look.subject}}` off a connector read, are
  unchecked (capabilities declare no OUTPUT schema) → silent blank column. Known.
- `tests/e2e/onboarding.test.js` has ~5 pre-existing failures unrelated to P12.
- Delivery channels don't format per-channel yet (HTML emitted to email/Slack ships raw) —
  known P10+ gotcha.

## 8. Process hazards

- **Do NOT run `mutation-sweep.mjs` / any mutation loop** while editing — it rewrites `src/`
  in place. If you must, run it FOREGROUND and `grep -rn "if (true)\|if (false)\|void 0 && " src/`
  after. Never `git checkout -- <file>` to restore (reverts to HEAD, eats uncommitted work).
- CLAUDE.md is the shared memory; if code and a doc disagree, fix the doc in the same commit.

## 9. How to report

Per workflow: what you built, the exact steps, screenshots, the test-panel verdict, and —
for any defect — a reproducer (intent + the request/response or file:line), classified as
**blocking** (user-reachable AND silent/destructive) vs **residual**. Rank blocking first.
Don't fix `src/` and test in the same breath without restarting the server.
