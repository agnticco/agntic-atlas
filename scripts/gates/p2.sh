#!/usr/bin/env bash
# Phase 2 — event triggers + Gmail.
# Done when: a hand-authored "email from UPS -> post to Slack" spec fires on a
# real email. The canonical demo runs, still hand-written, no converger.
# NOTE: freeze the spec here -> docs/specs/canonical-ups-slack.json (committed,
# never regenerated). The Phase 3 check diffs against that frozen file.
#
# Replace with the real check, e.g. inject a matching inbound email and assert
# the Slack post fired via the run log.
set -eu
cd "$(git rev-parse --show-toplevel)"

echo "p2: check not yet implemented — gate fails closed" >&2
echo "    implement: inbound UPS email -> event trigger -> Slack post fired" >&2
echo "    and: docs/specs/canonical-ups-slack.json exists and is committed" >&2
exit 1
