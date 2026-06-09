#!/usr/bin/env bash
# Phase 3 — the converger (the IP; long pole).
# Done when: from a vague typed intent, the converger reproduces the EXACT
# frozen spec (docs/specs/canonical-ups-slack.json), with each step's
# confirmation logged.
#
# Replace with the real check, e.g. run the headless converger on the canonical
# intent and diff its emitted spec against the frozen file; assert no diff and
# that a confirmation was logged per committed step.
set -eu
cd "$(git rev-parse --show-toplevel)"

frozen="docs/specs/canonical-ups-slack.json"
if [ ! -f "$frozen" ]; then
  echo "p3: $frozen missing — freeze it in Phase 2 first. Gate fails." >&2
  exit 1
fi

echo "p3: check not yet implemented — gate fails closed" >&2
echo "    implement: converger(canonical intent) == $frozen, confirmations logged" >&2
exit 1
