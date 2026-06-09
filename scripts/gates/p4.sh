#!/usr/bin/env bash
# Phase 4 — conversational builder UI (greenfield).
# Done when: the UPS workflow is built entirely by talking and confirming in the
# chat surface (inline step-proposal cards, explicit per-step confirm, live
# draft-vs-confirmed state, wired to the converger's event contract) — and it runs.
#
# Replace with the real check, e.g. an end-to-end UI test driving the builder
# conversation to a runnable workflow.
set -eu
cd "$(git rev-parse --show-toplevel)"

echo "p4: check not yet implemented — gate fails closed" >&2
echo "    implement: e2e — build UPS workflow via chat, confirm steps, run it" >&2
exit 1
