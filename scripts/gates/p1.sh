#!/usr/bin/env bash
# Phase 1 — prove the spine with a hardcoded workflow (no converger).
# Done when: clicking "run" posts to Slack — new repo <-> engine <-> MCP <->
# Slack <-> new UI proven end to end on a hand-authored one-step spec.
#
# Replace with the real check, e.g. run the one-step spec through the engine
# against a test Slack channel and assert the message landed (ts returned).
set -eu
cd "$(git rev-parse --show-toplevel)"

echo "p1: check not yet implemented — gate fails closed" >&2
echo "    implement: run hand-authored spec -> assert message posted to Slack" >&2
exit 1
