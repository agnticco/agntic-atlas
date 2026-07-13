#!/usr/bin/env bash
# Phase 12 — Converger v2: outcome contracts, decisions, gap analysis,
#            the elicitation UI, and the human approval gate.
#
# Build spec: docs/architecture/converger-v2.md   (theory: bpmn-dmn-foundations.md)
#
# Done when — the invariants of converger-v2.md §11:
#   0. REGRESSION. P3 still green (the converger reproduces the frozen canonical
#      spec), E2E green, cross-tenant isolation holds, tier caps hold.
#   A. Validator hardened (UNKNOWN_CONFIG_KEY); node library re-cut to `llm.mode`.
#   B. Engine control flow: branch / on_error / idempotency.
#   C. Converger v2 core: outcome + examples + decisions + gaps. THE MOAT:
#      no LLM decision input without a closed enum.
#   D. The human approval gate: durable pause, multi-channel, forgery-proof.
#      NO approval is ever authenticated by parsing an email body.
#   E. `decision` node + DMN gap analysis + the table review UI.
#   F. `foreach` + schema-aware connectors + the example picker.
#   G. Zero-typing path: a build completed entirely through defaults and clicks
#      yields a gap-free, publishable spec.
#
# This gate is PROGRESSIVE and FAIL-CLOSED. It runs the increments in order and
# stops at the first one that is not done, naming it. So at any point:
#
#     bash scripts/gate.sh 12
#
# answers both "is the phase closed?" and "which increment do I build next?".
# An unimplemented check does NOT pass. Do not weaken a check to force a pass —
# if a check is wrong, fix it and record why in CLAUDE.md (CLAUDE.md, Gates).
set -eu
cd "$(git rev-parse --show-toplevel)"

fail() { echo "p12 FAIL: $*" >&2; exit 1; }

# `next` = this increment is not built yet. Not a defect — the phase is simply
# not finished. Fail-closed all the same: the gate does not pass.
next() {
  echo "" >&2
  echo "p12: NOT CLOSED — next increment to build: $1" >&2
  echo "     spec: docs/architecture/converger-v2.md §10, increment $1" >&2
  echo "     missing: $2" >&2
  exit 1
}

# Run a node test file; fail with its tail on error.
#
# --env-file-if-exists=.env is LOAD-BEARING, not convenience. tests/e2e/
# full-journey.test.js SELF-SKIPS its converger test when ANTHROPIC_API_KEY is
# unset — and then reports a cheerful "6 pass / 1 skip", where the skipped test
# is the thing under test. Without the env file this gate ran the E2E with no
# key and passed itself on a suite that had quietly not tested the converger.
# That is how P11 was nearly closed on a false pass (CLAUDE.md, P11 note).
#
# So: load the env, AND fail closed on ANY skip. A skipped test is not a passed
# test. If you have no ANTHROPIC_API_KEY, this gate cannot be closed — that is
# the correct outcome, not an inconvenience to route around.
run_test() {
  local f="$1" label="$2"
  local log="/tmp/p12-$(basename "$f").log"
  node --env-file-if-exists=.env --test "$f" >"$log" 2>&1 \
    || { tail -40 "$log" >&2; fail "$label — $f did not pass"; }
  grep -qE '^# skipped 0$' "$log" \
    || { grep -E '^# (pass|fail|skipped)' "$log" >&2
         fail "$label — $f SKIPPED a test. A skipped test is not a passed test; the converger test self-skips without ANTHROPIC_API_KEY. Set it and re-run."; }
}

# ─────────────────────────────────────────────────────────────────────────────
# 0. REGRESSION — must hold at EVERY increment, not just at the end.
#    §11.1–§11.5. These are the things v2 is forbidden to break.
# ─────────────────────────────────────────────────────────────────────────────
echo "p12: [regression] P3 — converger still reproduces the frozen canonical spec..."
bash scripts/gates/p3.sh >/tmp/p12-p3.log 2>&1 \
  || { tail -40 /tmp/p12-p3.log >&2; fail "§11.1 P3 regressed — the converger no longer reproduces docs/specs/canonical-ups-slack.json"; }

echo "p12: [regression] E2E full journey..."
run_test tests/e2e/full-journey.test.js "§11.3 E2E"

echo "p12: [regression] cross-tenant adversarial isolation..."
node scripts/checks/p11-cross-tenant-adversarial.mjs >/tmp/p12-xt.log 2>&1 \
  || { tail -40 /tmp/p12-xt.log >&2; fail "§11.4 cross-tenant isolation broke"; }
grep -q 'CROSS-TENANT-ADVERSARIAL-PASS' /tmp/p12-xt.log || fail "§11.4 adversarial check did not report PASS"

echo "p12: [regression] tier caps / margin guard..."
node scripts/checks/tier-caps.mjs >/tmp/p12-tiers.log 2>&1 \
  || { tail -40 /tmp/p12-tiers.log >&2; fail "§11.5 tier caps failed — if the build got more expensive, re-derive BUILD_RUN_COST"; }

VALIDATOR="src/workflows/workflow-validator.js"
[ -f "$VALIDATOR" ] || fail "validator missing at $VALIDATOR"

# ─────────────────────────────────────────────────────────────────────────────
# A. Validator hardening + node re-cut.
# ─────────────────────────────────────────────────────────────────────────────
grep -q 'UNKNOWN_CONFIG_KEY' "$VALIDATOR" \
  || next "A — validator hardening + node re-cut" \
          "UNKNOWN_CONFIG_KEY not emitted by $VALIDATOR. This is the highest-leverage check in the phase: it turns 'the converger hallucinated a config field' from a silent production failure into a build-time error."

# The re-cut: these collapse into llm.js behind `mode`, or are unrunnable dead
# weight (no ToolRegistry exists — CLAUDE.md, Known gotchas).
for dead in summarize extract rewrite daily-digest tool mcp-tool fetch; do
  [ -f "src/workflows/node-types/${dead}.js" ] \
    && next "A — validator hardening + node re-cut" \
            "src/workflows/node-types/${dead}.js still exists; it must collapse into llm.js behind \`mode\` (or be deleted as unrunnable), with a v1 compat shim mapping the old type."
done
grep -q "mode" src/workflows/node-types/llm.js \
  || next "A — validator hardening + node re-cut" "llm.js has no \`mode\` (summarize|extract|rewrite|classify|freeform)."

# ─────────────────────────────────────────────────────────────────────────────
# B. Engine control flow.
# ─────────────────────────────────────────────────────────────────────────────
CF_TEST="tests/workflows/control-flow.test.js"
[ -f "$CF_TEST" ] \
  || next "B — engine control flow" \
          "$CF_TEST missing. Must prove: branch skips the non-selected subtree; foreach bounds at maxItems; human pauses and resumes from its checkpoint; and §11.2 — a spec WITHOUT a branch executes byte-identically to today."
echo "p12: [B] engine control flow..."
run_test "$CF_TEST" "increment B"

grep -q 'NON_EXHAUSTIVE_BRANCH' "$VALIDATOR" \
  || next "B — engine control flow" "NON_EXHAUSTIVE_BRANCH not in the validator — every branch needs a \`*\` case."

# ─────────────────────────────────────────────────────────────────────────────
# C. Converger v2 core — THE MOAT.
# ─────────────────────────────────────────────────────────────────────────────
GAP_TEST="tests/converger/gap-oracle.test.js"
[ -f "$GAP_TEST" ] \
  || next "C — converger v2 core + outcome/gap UI" \
          "$GAP_TEST missing. Must cover scoreGap() over crafted specs: unsatisfied assertion · table gap · UNIQUE overlap · non-exhaustive branch · unknown config key."
echo "p12: [C] gap oracle..."
run_test "$GAP_TEST" "increment C"

grep -q 'UNSATISFIED_ASSERTION' "$VALIDATOR" \
  || next "C — converger v2 core + outcome/gap UI" \
          "UNSATISFIED_ASSERTION not in the validator. Every outcome.assertions[] must map to >=1 node that satisfies it — this is what kills the 'Slack AND email' silent-drop defect."

# §11.7 — the moat. An LLM-evaluated decision input MUST be a classifier into a
# closed enum, never free text. Without this there is no completeness proof,
# and without the completeness proof there is no product.
grep -q 'LLM_INPUT_NOT_ENUM' "$VALIDATOR" \
  || next "C — converger v2 core + outcome/gap UI" \
          "§11.7 LLM_INPUT_NOT_ENUM not in the validator. THIS IS THE MOAT: no decision input may have evaluator:'llm' without a closed enum of values."

ADV="scripts/checks/converger-adversarial.mjs"
[ -f "$ADV" ] \
  || next "C — converger v2 core + outcome/gap UI" \
          "$ADV missing. Contradictory outcomes; unstateable outcomes; an outcome needing an absent connector. It must NEVER silently drop an assertion."
echo "p12: [C] converger adversarial..."
node "$ADV" >/tmp/p12-cadv.log 2>&1 || { tail -40 /tmp/p12-cadv.log >&2; fail "increment C — converger adversarial check failed"; }
grep -q 'CONVERGER-ADVERSARIAL-PASS' /tmp/p12-cadv.log || fail "increment C — converger adversarial did not report PASS"

# ─────────────────────────────────────────────────────────────────────────────
# D. The human approval gate.
#    An approval anyone can forge is not an approval. See converger-v2.md §7.
# ─────────────────────────────────────────────────────────────────────────────
APPR_TEST="tests/approvals/approval-store.test.js"
[ -f "$APPR_TEST" ] \
  || next "D — human approval gate + channels + Approvals inbox" \
          "$APPR_TEST missing. Must prove: token stored SHA-256 HASHED · single-use (replay rejected) · TTL expiry · approve/reject are DISTINCT tokens that mutually invalidate (so a forwarded 'approve' link cannot be flipped) · timeout takes the declared path."
echo "p12: [D] approval store..."
run_test "$APPR_TEST" "increment D"

grep -q 'HUMAN_WITHOUT_TIMEOUT' "$VALIDATOR" \
  || next "D — human approval gate + channels + Approvals inbox" \
          "HUMAN_WITHOUT_TIMEOUT not in the validator — a pause with no timeout is a workflow that hangs forever."
grep -q 'WEAK_APPROVAL_FOR_WRITE' "$VALIDATOR" \
  || next "D — human approval gate + channels + Approvals inbox" \
          "WEAK_APPROVAL_FOR_WRITE not in the validator — the approval channel must be at least as strong as the action is risky (§7.2)."

# §11.8 — hard rule. SPF/DKIM authenticate a sending DOMAIN, not a human INTENT;
# `From:` is spoofable and a forwarded thread is full of the word "yes".
# Email approvals use a signed, hashed, single-use magic link, or they do not exist.
grep -q 'EMAIL_REPLY_APPROVAL' "$VALIDATOR" \
  || next "D — human approval gate + channels + Approvals inbox" \
          "§11.8 EMAIL_REPLY_APPROVAL not in the validator. Parsing an approval out of an email reply body MUST be a hard validation error."

APPR_ADV="scripts/checks/approval-adversarial.mjs"
[ -f "$APPR_ADV" ] \
  || next "D — human approval gate + channels + Approvals inbox" \
          "$APPR_ADV missing. Forged approvals: unsigned Slack block_actions rejected · a token from tenant A cannot resolve a run in tenant B · a replayed magic link is rejected · email_reply rejected."
echo "p12: [D] approval adversarial (forgery)..."
node "$APPR_ADV" >/tmp/p12-aadv.log 2>&1 || { tail -40 /tmp/p12-aadv.log >&2; fail "increment D — approval adversarial check failed"; }
grep -q 'APPROVAL-ADVERSARIAL-PASS' /tmp/p12-aadv.log || fail "increment D — approval adversarial did not report PASS"

# ─────────────────────────────────────────────────────────────────────────────
# E. `decision` node + DMN gap analysis + table review UI.
# ─────────────────────────────────────────────────────────────────────────────
grep -q 'DECISION_TABLE_GAP' "$VALIDATOR" \
  || next "E — decision node + table review UI + DMN gap analysis" \
          "DECISION_TABLE_GAP not in the validator — an uncovered enum combination must be reported BEFORE publish."
grep -q 'UNIQUE_HIT_OVERLAP' "$VALIDATOR" \
  || next "E — decision node + table review UI + DMN gap analysis" \
          "UNIQUE_HIT_OVERLAP not in the validator — hitPolicy UNIQUE with overlapping rules must be rejected."
[ -f "src/workflows/node-types/decision.js" ] \
  || next "E — decision node + table review UI + DMN gap analysis" \
          "src/workflows/node-types/decision.js missing. Gap analysis MUST use box subtraction, never cross-product enumeration (measured: 10 inputs x 10 values = 10^10 combinations in 1 ms — scripts/checks/gap-analysis-bench.mjs). Decompose at >4 inputs: the limit is cognitive, not computational."

# ─────────────────────────────────────────────────────────────────────────────
# F. `foreach` + schema-aware connectors + the example picker.
# ─────────────────────────────────────────────────────────────────────────────
FLAGSHIP="tests/e2e/write-shaped.test.js"
[ -f "$FLAGSHIP" ] \
  || next "F — foreach + schema-aware connectors + example picker" \
          "$FLAGSHIP missing. The flagship: inbound email → extract → decide → Airtable record + Slack, buildable by conversation and clicks ALONE — no pasted base ID, no typed example."
echo "p12: [F] flagship write-shaped E2E..."
run_test "$FLAGSHIP" "increment F"

# ─────────────────────────────────────────────────────────────────────────────
# G. The zero-typing path. §11.9 — every interrupt carries a default.
#    v2 elicits strictly more than v1. If that arrives as a 40-question
#    interrogation it kills activation, and a v2 that elicits more but converts
#    less is a net loss. This test is what keeps that honest.
# ─────────────────────────────────────────────────────────────────────────────
ZT="tests/e2e/zero-typing-build.test.js"
[ -f "$ZT" ] \
  || next "G — outcome oracle + SOP + the zero-typing path" \
          "$ZT missing. §11.9: a build completed entirely through defaults and clicks must yield a gap-free, PUBLISHABLE spec — because every unresolved gap defaults to 'escalate to a human' (§7), which is safe and honest."
echo "p12: [G] zero-typing build path..."
run_test "$ZT" "increment G"

echo ""
echo "p12 PASS: converger v2 closed."
echo "  regression: P3 canonical spec reproduced; E2E green; cross-tenant isolation holds; tier caps hold"
echo "  A validator hardened + node library re-cut"
echo "  B branch / on_error / idempotency"
echo "  C outcome contracts + gap oracle + THE MOAT (no LLM decision input without a closed enum)"
echo "  D human approval gate — forgery-proof, no email-body authentication"
echo "  E decision tables + DMN gap analysis (box subtraction)"
echo "  F foreach + schema-aware connectors + example picker"
echo "  G zero-typing path — a provably complete workflow, published without typing"
exit 0
