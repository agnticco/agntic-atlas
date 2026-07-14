# Brief — P12 Increment D: the human approval gate (channels · forgery-proof tokens · Approvals inbox)

**Grounded against `main` @ `4319afb` on 2026-07-13** (C merged there).
Line numbers below are **non-authoritative provenance** — re-ground against the exported symbol
before you act. The **invariant + the acceptance test** are the contract, not the coordinates. If the
premise doesn't match current code, **say so and stop** — refusing to fix a non-bug is correct
discipline, not obstruction.

---

## Your role

You are the **Builder** for **one** deliverable: **P12, Increment D**. Nothing else.

Read `CLAUDE.md` first — it is the constitution and overrides anything here that conflicts. Start a
**fresh session**; rehydrate from the *documents*, not from scrollback.

---

## Orient (first command)

```bash
bash scripts/gate.sh 12
```

Progressive and fail-closed. It runs the regression block, A, B and **C** (all green), then **stops
at D** and names the first missing thing. It is the definition of done, executable. **Allow ~25 min**
— it now runs two mutation harnesses and a live-model adversarial check.

Then read, in this order:
1. `CLAUDE.md` — the closed decisions, the don't-touch salvage list, and especially:
   - **"The verification system had an architectural flaw. Three, actually."** — the apparatus you
     inherit and must uphold;
   - the P12 increment **A / B / C** recorded edits — what already changed and why. **Read C's two
     entries in full.** They are the most recent, and the second one (the verifier's findings) is the
     one you are most likely to re-create.
2. `docs/architecture/converger-v2.md` — **§7 in its entirety** (this is your spec: the node shape,
   the channel trust table, the token model, the durable-pause mechanics, the new validator codes),
   plus **§10 → Increment D**, and **§11.8**.
3. `scripts/gates/p12.sh` — the D block is your checklist.

---

## What C left you (the ground you are building on)

- **The engine half of `human` already exists** (Increment B). `FlowTester` pauses the run, emits
  `run_paused` with an explicit **`checkpoint`** (`{outputs, skipped, live, ruledOut, lastOutput}`),
  and `WorkflowScheduler` parks the run as `awaiting_human`. Resume restores liveness **from the
  checkpoint** and never re-derives it. **Do not rebuild any of this. Read it.**
- **A `human` node is deliberately unreachable today.** Nothing DELIVERS the ask. The converger does
  not emit one and the builder cannot add one — precisely so no user workflow can park itself waiting
  for a question nobody will ever be asked. **D is what makes it reachable.** Until your channels
  work, do not surface `human` in the converger prompt or the builder UI.
- **A `branch` may already route on a `human`.** `closedDomainOf()` in `workflow-validator.js`
  declares a human's closed domain as `approve | reject | timeout`. Your `config.decisions` must
  agree with it — it is the single definition of "what values can this node emit", shared by the moat
  allowlist and `BRANCH_CASE_NOT_IN_ENUM`. If you change the decision vocabulary, change it there.
- **Escalation is the default resolution of every gap** (`gap-scorer.js`). C records escalated gaps
  as provenance but **cannot yet materialise them**, because materialising one means emitting a
  `human` node. **D is what makes C's "Accept all defaults" button honest.** That is the through-line
  of this increment: it is not a feature, it is the payment on a promise C already made to the user.

---

## The work (converger-v2 §7)

### 1. `ApprovalStore` — `src/approvals/approval-store.js` (new)

Mirror `src/auth/password-reset-store.js` **verbatim in shape** — it already solved this and is
battle-tested. Its own SQLite, fail-closed on tenant.

- `newApprovalToken()` → 32 random bytes, base64url.
- Store the **SHA-256 hash only**. The raw token exists solely in the email.
- **Single-use** — consumed on first valid click.
- **TTL**, defaulting to the node's `timeout.after`.
- **One token per `(runId, nodeId, decision)`.** Approve and reject are *different* tokens, so a
  forwarded "approve" link cannot be flipped to "reject" by editing a query param. **Consuming either
  invalidates BOTH** — one approval, one answer.

### 2. Channels — the ask, delivered (§7.2)

| Channel | Ask | Answer | Trust |
|---|---|---|---|
| `inbox` | in-app item (`src/inbox/`) | click, authenticated session | **strong** |
| `slack` | Block Kit message + buttons | `block_actions` → **HMAC-verified** with `SLACK_SIGNING_SECRET` | **strong** |
| `email` | email with **signed magic links** | `GET /approvals/:token` → hashed, single-use, TTL | **medium** |
| ~~`email_reply`~~ | — | parse "yes" from a body | **FORBIDDEN** |

`POST /connectors/slack/interactive` is **new**. Slack Block Kit buttons post to the *Interactivity*
Request URL — **not** to `/connectors/slack/events`, which already exists. Register it in the Slack
app manifest.

`GET /approvals/:token` is a **`GET` from a mail client** — it must be safe to prefetch. Render a
confirmation page and **require a POST to actually consume**, or a scanning proxy approves the
customer's refund for them.

### 3. Validator codes (§7.7)

`HUMAN_WITHOUT_TIMEOUT` · `WEAK_APPROVAL_FOR_WRITE` · `APPROVAL_CHANNEL_NOT_CONNECTED` ·
**`EMAIL_REPLY_APPROVAL`**.

### 4. The timeout sweeper

On the existing 60 s scheduler tick: when `now > expires_at`, fire `timeout.then`. **The scheduler
must not re-fire an `awaiting_human` run** (B already parks it; confirm it stays parked).

### 5. UI

Approvals inbox items with Approve/Reject; the Slack Block Kit message; the approval email.

---

## Acceptance (this is the contract — §10-D)

- [ ] An unresolved gap **publishes safely** and routes to the inbox at run time — i.e. C's *"Accept
      all defaults"* now materialises a real `human` node, and it is reachable.
- [ ] An approval is accepted **from Slack** and **from an email magic link**, each recorded with
      **who** and **how**.
- [ ] A **replayed magic link is rejected** (single-use).
- [ ] A run with no answer hits `timeout` and takes the **declared path**.
- [ ] `email_reply` is **rejected by the validator**.
- [ ] `bash scripts/gate.sh 12` gets **past D and stops at E.** (Still exits non-zero — correct.
      Success = the failure reason moves from D to E.) The D checks:
  - `tests/approvals/approval-store.test.js` — token stored **SHA-256 hashed** · single-use (replay
    rejected) · TTL expiry · approve/reject are **distinct tokens that mutually invalidate** ·
    timeout takes the declared path.
  - `HUMAN_WITHOUT_TIMEOUT`, `WEAK_APPROVAL_FOR_WRITE`, `EMAIL_REPLY_APPROVAL` in the validator.
  - `scripts/checks/approval-adversarial.mjs` reports `APPROVAL-ADVERSARIAL-PASS`: an **unsigned**
    Slack `block_actions` is rejected · a token from **tenant A cannot resolve a run in tenant B** ·
    a **replayed** magic link is rejected · `email_reply` is rejected.
- [ ] **Regression stays green** — P3, E2E (**7/7 with `ANTHROPIC_API_KEY`**; it self-skips the
      converger test without one and still reports a cheerful "6 pass / 1 skip", where the skipped one
      is the thing under test), cross-tenant, tier caps, mutation-guard, mutation-sweep
      (**floor 0.78 — a RATCHET; raise it, never lower it**).

---

## The invariants — do not break these

1. **§11.8 — NO APPROVAL IS EVER AUTHENTICATED BY PARSING AN EMAIL BODY.** SPF/DKIM authenticate a
   sending *domain*, not a human *intent*; `From:` is trivially spoofable and a forwarded thread is
   full of the word "yes". Signed, hashed, single-use magic links, or the channel does not exist.
2. **§11.7 `LLM_INPUT_NOT_ENUM` — the moat.** Untouched. If you add `human` as a branch source, it is
   already in `closedDomainOf()`; keep the two in agreement.
3. **`complete ⇒ publishable`** — and it holds **only because the gap scorer fails closed**
   (`CHANNELS_UNVERIFIED`). If you add a check the scorer cannot see, you break it. **Any new
   validator rule that depends on a dependency the scorer may not have MUST fail closed, not skip.**
4. **The persisted steps are NOT the checkpoint** (§7.4). They are display-shrunk (truncated at 2000
   chars). Resume from `workflow_runs.checkpoint`.
5. **A `branch` / `human` output is never `lastOutput`** — `deliver` sends `ctx.lastOutput`, so
   leaving them in delivers `{"decision":"approve",…}` to the customer instead of the approved reply.
6. Cross-tenant isolation, tier caps, P3.

---

## The verification apparatus you INHERIT (and must uphold)

- **A green suite is evidence of nothing until you have watched it go red.** Mutation-test every
  guard you add: re-introduce the bug, confirm a test fails, restore.
- **Never quote a mutation score in a doc.** State the rule; let the verifier re-derive the number.
  Two builders in this phase published scores an independent check falsified.
- **Spawn the `test-adversary` after you build, BEFORE the verifier.** It may write `tests/` and
  `scripts/checks/` and **must not touch `src/`**. On C it found **five** defects — including the
  moat itself bypassed by one laundering hop — all behind a fully green suite.
- **Then the fresh `verifier`.** On C it found a **user-facing dead end** (`complete` ⇒ a spec that
  would not publish) *and* the fact that **the check written to prove that invariant was
  structurally incapable of failing**.
- **The survivor list from `mutation-sweep.mjs` IS the coverage report. Read it.** On C it named the
  exact line of the blocker as a survivor and the builder read past it.

### The lesson C paid for twice — do not pay for it a third time

> **A check must construct its subject the way PRODUCTION constructs it.**

`converger-adversarial.mjs` scored with no capabilities and validated with no `channelRegistry` —
both sides equally blind, so a real divergence was invisible **by construction**. Production
validates *with* a registry (`server.js:542`). This is CLAUDE.md **architectural flaw #2**, and it
has now recurred in every increment of this phase.

**For D this is a loaded gun.** Your approval paths depend on `SLACK_SIGNING_SECRET`, an
`ApprovalStore`, and a tenant scope. If a test constructs the verifier *without* a signing secret, or
hand-passes a `tenantId` no production caller passes, **your forgery check will pass while
production is wide open.** That is exactly how Increment B leaked one tenant's output into another
tenant's run. **Write the adversarial check against the wiring `server.js` actually builds.**

---

## Hard rules

- **Evidence-gating.** No "missing/broken/dead" claim without a `file:line` or the exact command that
  returned nothing.
- **Never weaken a gate, a check, or a test to force a pass. Never `--no-verify`.** If a check is
  wrong, fix the check and record why in `CLAUDE.md`, in the same commit.
- **Keep the docs true in the same commit as the code.** E rehydrates from `CLAUDE.md` +
  `converger-v2.md`. If your work falsifies §7, fix §7 — that is a deliverable, not a follow-up.
- No `Co-Authored-By` / "Generated with Claude Code". No `Gate:` trailer (D does not close the
  phase). `Phase: 12` trailer. Branch `feat/p12-increment-d` **from `main`**, never from an unmerged
  branch.
- **Do not deploy.** Do not start E (`decision` node / DMN table UI). Do not touch billing, Stripe,
  tenancy, or the connectors beyond what D needs.

## Process

1. `git checkout main && git pull` → `git checkout -b feat/p12-increment-d`.
2. Build. Run `bash scripts/gate.sh 12` as you go.
3. Commit per `docs/COMMIT_CONVENTION.md` (`Phase: 12`, header ≤72 chars, no `Gate:` trailer).
4. **`test-adversary` → then `verifier`.** Merge only on an independent PASS.

## If the brief's premise doesn't match the code

Believe the code. Report the mismatch with evidence and stop. Do not invent work to satisfy a stale
instruction.
