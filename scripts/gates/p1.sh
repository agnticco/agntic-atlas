#!/usr/bin/env bash
# Phase 1 — prove the spine with a hardcoded workflow (no converger).
#
# Done when: clicking "run" posts to Slack — a hand-authored one-step spec runs
# through the engine and a message lands in Slack (chat.postMessage returns a ts).
#
# The check boots the real spine, mounts the HTTP app, and POSTs the spec to
# /workflows/run (the "click run" path; no UI yet). By default it posts to a local
# STUB Slack and asserts the request payload + returned ts — reproducible, no
# secrets. Set SLACK_BOT_TOKEN (+ unset SLACK_API_URL, set SLACK_TARGET) for a real
# workspace post; the same assertions validate it. Fail-closed.
set -eu
cd "$(git rev-parse --show-toplevel)"

# THE GATE CANNOT SEND REAL EMAIL — blanks every mail credential for this script's
# children and refuses to run if the mailer is still live. scripts/gate.sh sources it
# too, but this script is runnable directly (`bash scripts/gates/p1.sh`), and that
# path bypasses gate.sh entirely.
. scripts/gates/_no-mail.sh

fail() { echo "p1 FAIL: $*" >&2; exit 1; }

# Artifacts exist.
[ -f src/connectors/slack/index.js ]   || fail "Slack connector src/connectors/slack/index.js missing"
[ -f docs/specs/p1-slack-hello.json ]  || fail "hand-authored spec docs/specs/p1-slack-hello.json missing"
node -e 'JSON.parse(require("fs").readFileSync("docs/specs/p1-slack-hello.json","utf8"))' \
  || fail "p1-slack-hello.json is not valid JSON"

# Run the spec through the engine -> Slack.
echo "── p1: run hand-authored spec through engine -> Slack ──"
out="$(node scripts/checks/slack-post.mjs 2>&1)" || { echo "$out" | tail -25 >&2; fail "slack-post check errored"; }
echo "$out" | grep -E 'capability:|run .* posted|stub received' || true
echo "$out" | grep -q 'SLACK-POST-PASS' || { echo "$out" | tail -25 >&2; fail "spec did not post to Slack"; }

echo "p1 PASS: hand-authored spec ran through the engine and posted to Slack (chat.postMessage returned a ts)"
exit 0
