#!/usr/bin/env bash
# Phase 0 — clean spine.
#
# Done when:
#   1. the migrated engine + auth boot in the new repo (server starts without error),
#   2. the empty UI can reach it over one health route: GET /health -> 200 with the
#      expected payload (status/engine/auth all "ok"), and
#   3. the new src/api/server.js is clean UTF-8 — no NUL byte / encoding that makes
#      plain `grep` stop early (the agntic-prod server.js gotcha must NOT recur).
#
# Fail-closed: any unmet condition exits non-zero.
set -eu
cd "$(git rev-parse --show-toplevel)"

# THE GATE CANNOT SEND REAL EMAIL — blanks every mail credential for this script's
# children and refuses to run if the mailer is still live. scripts/gate.sh sources it
# too, but this script is runnable directly (`bash scripts/gates/p0.sh`), and that
# path bypasses gate.sh entirely.
. scripts/gates/_no-mail.sh

SERVER="src/api/server.js"
PORT="${P0_GATE_PORT:-3987}"
LOG="$(mktemp -t atlas-p0-gate.XXXXXX)"
SRV_PID=""

cleanup() {
  [ -n "$SRV_PID" ] && kill "$SRV_PID" 2>/dev/null || true
  [ -n "$SRV_PID" ] && wait "$SRV_PID" 2>/dev/null || true
  rm -f "$LOG"
  rm -rf "${P0_TMP:-}" 2>/dev/null || true
}
trap cleanup EXIT

fail() { echo "p0 FAIL: $*" >&2; exit 1; }

# --- Condition 3: encoding cleanliness (check before boot; cheap + load-bearing) ---
[ -f "$SERVER" ] || fail "$SERVER does not exist"

# No NUL byte anywhere in the file (the agntic-prod gotcha was a literal \x00).
if perl -0777 -ne 'exit(index($_, "\x00") >= 0 ? 1 : 0)' "$SERVER"; then
  :
else
  fail "$SERVER contains a NUL byte — encoding gotcha recurred"
fi

# Behavioral proof that plain grep is NOT defeated: an un-flagged grep must find a
# known token and return the SAME count as a forced-text grep. If a NUL/encoding
# issue made grep stop early, plain would be 0 (or 'Binary file matches').
plain_count="$(grep -c 'express' "$SERVER" || true)"
forced_count="$(grep -ac 'express' "$SERVER" || true)"
[ "${plain_count:-0}" -ge 1 ] || fail "plain grep found 0 matches in $SERVER (encoding defeats grep)"
[ "$plain_count" = "$forced_count" ] || fail "plain grep ($plain_count) != grep -a ($forced_count) — $SERVER not clean text"

# --- Conditions 1 & 2: boot + health route ---
# Use temp dirs so the gate never touches the real ./memory (which holds OAuth tokens).
P0_TMP="$(mktemp -d -t atlas-p0-data.XXXXXX)"
WORKFLOWS_DB="$P0_TMP/w.sqlite" SOURCES_DB="$P0_TMP/s.sqlite" VECTOR_DIR="$P0_TMP/v" \
  AUTH_DB="$P0_TMP/a.sqlite" AUTH_SECRET="$P0_TMP/.jwt" OAUTH_DB="$P0_TMP/o.sqlite" OAUTH_KEY="$P0_TMP/.okey" \
  PORT="$PORT" node "$SERVER" >"$LOG" 2>&1 &
SRV_PID=$!

# Poll for the listener (up to ~10s).
ready=""
for _ in $(seq 1 50); do
  if ! kill -0 "$SRV_PID" 2>/dev/null; then
    cat "$LOG" >&2
    fail "server process exited during boot (engine or auth failed to boot)"
  fi
  if curl -fs "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then ready=1; break; fi
  sleep 0.2
done
[ -n "$ready" ] || { cat "$LOG" >&2; fail "server did not answer /health within timeout"; }

# Assert 200 + expected payload.
code="$(curl -s -o /tmp/atlas-p0-health.json -w '%{http_code}' "http://127.0.0.1:${PORT}/health")"
body="$(cat /tmp/atlas-p0-health.json)"; rm -f /tmp/atlas-p0-health.json
[ "$code" = "200" ] || fail "/health returned HTTP $code (expected 200); body=$body"

echo "$body" | grep -q '"status":"ok"'  || fail "/health payload missing status=ok: $body"
echo "$body" | grep -q '"engine":"ok"'  || fail "/health payload reports engine not ok: $body"
echo "$body" | grep -q '"auth":"ok"'    || fail "/health payload reports auth not ok: $body"

echo "p0 PASS: engine+auth boot; GET /health -> 200 $body; $SERVER is clean UTF-8 (grep ok, no NUL)"
exit 0
