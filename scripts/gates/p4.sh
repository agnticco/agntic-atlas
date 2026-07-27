#!/usr/bin/env bash
# Phase 4 — conversational builder UI (greenfield), rebuilt from the
# three-screen design export at docs/design/p4-export-2026-06-17/.
#
# Design-first workflow:
#   1. Claude generates mockups for the chat surface
#   2. User approves → design recorded at docs/design/p4-builder-approved.md
#   3. UI built from the approved export, wired to the real converger
#   4. Converger drives the proposal/confirm conversation; the assembled spec
#      runs on the real execution engine before publish
#
# Done when:
#   1. Approved design exists at docs/design/p4-builder-approved.md
#   2. The UPS workflow is built entirely by talking + confirming in the chat
#      surface (inline proposal cards, explicit per-step confirm/change/reject,
#      live draft-vs-confirmed state), wired to the converger's real
#      session interrupt contract (proposal / clarification / ratify / done)
#   3. The resulting spec runs on the execution engine (Run test → /workflows/run)
#
# NOTE (2026-06-17): the previous version of this gate asserted `mention-chip`
# and `picker-chip path` affordances. Those belonged to an earlier UI attempt and
# do NOT exist in the approved second export (they are @-mention / filesystem-path
# pickers, P8 territory). They were removed here so the gate matches the approved
# design. The structural checks below assert markers that actually exist in the
# rebuilt UI; the load-bearing checks are the converger-endpoint + run-engine wiring.
set -eu
cd "$(git rev-parse --show-toplevel)"

# THE GATE CANNOT SEND REAL EMAIL — blanks every mail credential for this script's
# children and refuses to run if the mailer is still live. scripts/gate.sh sources it
# too, but this script is runnable directly (`bash scripts/gates/p4.sh`), and that
# path bypasses gate.sh entirely.
. scripts/gates/_no-mail.sh

fail() { echo "p4 FAIL: $*" >&2; exit 1; }

# ── 1. Approved design doc exists ────────────────────────────────────────────
DESIGN_DOC="docs/design/p4-builder-approved.md"
[ -f "$DESIGN_DOC" ] || fail "approved design doc missing at $DESIGN_DOC — complete design phase first"
[ -d "docs/design/p4-export-2026-06-17" ] || fail "canonical design export missing at docs/design/p4-export-2026-06-17/"

# ── 2. UI + backend files present and mounted ────────────────────────────────
UI_FILE="public/index.html"
[ -f "$UI_FILE" ]            || fail "builder UI missing at $UI_FILE"
[ -f "src/api/builder.js" ]  || fail "builder API missing at src/api/builder.js"
[ -f "src/converger/index.js" ] || fail "converger not found at src/converger/index.js"
grep -q "mountBuilderRoutes" src/api/server.js || fail "mountBuilderRoutes not called in server.js"
grep -q "express.static"     src/api/server.js || fail "express.static not found in server.js — public/ not served"

# ── 3. UI wires the real session-based converger contract ────────────────────
grep -q "/api/builder/sessions"   "$UI_FILE" || fail "UI does not call /api/builder/sessions"
grep -q "respond"                 "$UI_FILE" || fail "UI does not call the sessions respond endpoint"
grep -q "/api/builder/workflows"  "$UI_FILE" || fail "UI does not persist via /api/builder/workflows"
# every converger interrupt type the UI must handle
grep -q "ratify"                  "$UI_FILE" || fail "UI does not handle the ratify interrupt"
grep -q "clarification"           "$UI_FILE" || fail "UI does not handle clarification interrupts"
grep -q "request_changes"         "$UI_FILE" || fail "UI cannot request changes on the assembled spec"
# structural edge proposals are auto-accepted silently (decision 2026-06-17)
grep -q 'component === "edge"'    "$UI_FILE" || fail "UI does not auto-accept structural edge proposals"

# ── 4. Run test executes the assembled spec on the real engine ───────────────
grep -q "/workflows/run"          "$UI_FILE" || fail "Run test is not wired to the real engine (/workflows/run)"

# ── 5. Proposal card + confirm/change/reject affordances ─────────────────────
grep -q "Proposal ·"              "$UI_FILE" || fail "proposal card eyebrow not found in UI"
grep -q "item.onConfirm"          "$UI_FILE" || fail "proposal Confirm action not wired"
grep -q "item.onChange"           "$UI_FILE" || fail "proposal Change-it action not wired"
grep -q "item.onReject"           "$UI_FILE" || fail "proposal Not-this action not wired"

# ── 6. Draft + Live modes present ────────────────────────────────────────────
grep -q "modeDraft"               "$UI_FILE" || fail "draft mode not found in UI"
grep -q "modeLive"                "$UI_FILE" || fail "live mode not found in UI"

# ── 7. Login + first-run setup gate present (all routes are auth-gated) ──────
grep -q "login-overlay"           "$UI_FILE" || fail "login overlay not found in UI"
grep -q "setup-form"              "$UI_FILE" || fail "first-run setup form not found in UI"

# ── 7b. Full working experience (inference, connect, mentions, account) ──────
# The server must load .env so cloud inference (Anthropic) is used, not local.
grep -q "env-file" package.json || fail "npm start does not load .env (inference would fall back to local model)"
# Login must set a session cookie so OAuth connect navigations carry auth.
grep -q "setSessionCookie" src/api/server.js || fail "login does not set a session cookie (OAuth connect can't carry auth)"
# OAuth callbacks must return the browser to the app, not raw JSON.
grep -q "connected=slack" src/api/server.js || fail "slack callback does not redirect back to the app"
# Chat-first conversation layer: the user talks naturally and only builds when ready.
grep -q "/api/builder/chat" src/api/builder.js || fail "no conversational chat endpoint in builder API"
grep -q "sendChat" "$UI_FILE" || fail "UI has no chat phase (sendChat)"
grep -q "startBuild" "$UI_FILE" || fail "UI cannot transition from chat into building (startBuild)"
# Conversational opener + @-mention backend.
grep -q "introMessage" src/api/builder.js || fail "no conversational opener (introMessage) in builder API"
grep -q "/api/builder/mentions" src/api/builder.js || fail "no @-mention endpoint in builder API"
# UI wiring for connect, mentions, account.
grep -q "connectProvider" "$UI_FILE" || fail "Connect buttons not wired in UI"
grep -q "/api/builder/mentions" "$UI_FILE" || fail "UI does not load @-mention data"
grep -q "mentionItems" "$UI_FILE" || fail "@-mention autocomplete not present in UI"
grep -q "modeAccount" "$UI_FILE" || fail "Account settings surface not present in UI"

# ── 8. The embedded builder logic actually parses (catches a broken build) ───
TMPDIR_P4="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_P4"' EXIT
TMPJS="$TMPDIR_P4/xdc.js"
sed -n '/<script type="text\/x-dc" data-dc-script>/,/^<\/script>/p' "$UI_FILE" | sed '1d;$d' > "$TMPJS"
[ -s "$TMPJS" ] || fail "could not extract the x-dc builder script from $UI_FILE"
node --check "$TMPJS" || fail "the x-dc builder script in $UI_FILE has a syntax error"

echo "p4: all structural checks pass"
