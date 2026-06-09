#!/usr/bin/env bash
# Phase 7 — third connector + reliability.
# Done when: all three of Maggie's connectors are live (Airtable + Google write/
# Sheets/Forms alongside Slack/Gmail), failures retry and notify, and sub-daily
# scheduling works — "executes reliably" is actually true.
#
# Replace with the real check, e.g. connector integration tests + a forced
# failure that retries and notifies + a sub-daily schedule firing.
set -eu
cd "$(git rev-parse --show-toplevel)"

echo "p7: check not yet implemented — gate fails closed" >&2
echo "    implement: connectors live + retry/notify on failure + sub-daily schedule" >&2
exit 1
