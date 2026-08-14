#!/usr/bin/env bash
# Atlas gate runner. Runs a phase's objective "Done when" check.
#   usage: bash scripts/gate.sh <phase 0-13>
# Exit 0 = the phase's check passed; non-zero = gate is not met.
# This is the deterministic backbone of the hard gate: the pre-push hook and the
# review process both call it. It is intentionally fail-closed — a phase whose
# check is unimplemented does NOT pass.
set -eu

cd "$(git rev-parse --show-toplevel)"

# THE GATE CANNOT SEND REAL EMAIL — blanks the mail credentials for every child of
# this run and refuses to start if the mailer is still live. See the file for the
# measured reason (a P12 step really does reach the mailer). Sourced here because
# this is the entrypoint the pre-push hook and the verifier both call; the gates
# that load .env source it themselves too, for a direct `bash scripts/gates/pN.sh`.
. scripts/gates/_no-mail.sh

phase="${1:-}"
case "$phase" in
  0|1|2|3|4|5|6|7|8|9|10|11|12|13) ;;
  *) echo "gate: usage: bash scripts/gate.sh <phase 0-13>" >&2; exit 2 ;;
esac

check="scripts/gates/p${phase}.sh"
if [ ! -f "$check" ]; then
  echo "gate: no check script at $check — gate FAILS (fail-closed)" >&2
  exit 1
fi

echo "── gate: running Phase $phase check ($check) ──"
if bash "$check"; then
  echo "── gate: Phase $phase check PASSED ──"
  exit 0
else
  rc=$?
  echo "── gate: Phase $phase check FAILED (exit $rc) ──" >&2
  exit "$rc"
fi
