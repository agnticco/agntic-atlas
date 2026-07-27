# shellcheck shell=bash
# _no-mail.sh — THE GATE CANNOT SEND REAL EMAIL. Sourced by scripts/gate.sh and by
# every gate script that loads .env. Source it AFTER the `cd` to the repo root.
#
# ── Why this exists ──────────────────────────────────────────────────────────
#
# Operator's decision (2026-07-27): remove sending from the test gate entirely
# rather than guard it. Sending has already been proven to work; it does not need
# to be exercised on every gate run, and a checkpoint that can email real people is
# a checkpoint nobody can safely run.
#
# This is NOT hypothetical. `scripts/checks/approval-adversarial.mjs` (P12
# increment D) boots the REAL server and parks two runs on a `human` node whose
# channels are `[{inbox}, {email, to: ops@acme.test}]`. `ApprovalService.deliverAsk`
# dispatches every declared channel in parallel, so on every P12 run that check
# reaches the real mailer and tries to send TWO approval emails — each carrying a
# LIVE single-use approval magic link. It got away with it only because that one
# invocation happens to omit `--env-file-if-exists=.env` while every other node
# invocation in p12.sh has it. Measured 2026-07-27 with a local SMTP catcher: with
# mail credentials in the environment, two messages are delivered and the check
# still prints APPROVAL-ADVERSARIAL-PASS and exits 0 — `Promise.allSettled` in
# `deliverAsk` swallows the outcome either way, so the send is SILENT.
#
# ── Why blanking the shell environment is enough ─────────────────────────────
#
# Measured on Node v22.22.2, in this worktree, both directions: a variable already
# present in the process environment is NOT overwritten by `--env-file` or
# `--env-file-if-exists`, and an EMPTY string counts as present.
#
#   FAKE_VAR=from_shell node --env-file-if-exists=.env probe.js  -> "from_shell"
#   FAKE_VAR=          node --env-file-if-exists=.env probe.js  -> ""
#   (with FAKE_VAR=from_file in the .env file, and --env-file behaving identically)
#
# So exporting these empty here beats whatever .env says, for every descendant of
# the gate — including a gate step added later that nobody remembered to guard, and
# including a step invoked WITHOUT --env-file that would otherwise have inherited a
# credential exported in the operator's own shell.
#
# Every one of these is falsy-checked by `mode()` in src/utils/mailer.js
# (`process.env.X?.trim()` / `A && B`), so an empty string forces mode 'none' and
# `mailerConfigured()` to false. ANTHROPIC_API_KEY is deliberately NOT touched: the
# gate loads .env for exactly that key (tests/e2e/full-journey.test.js self-skips
# the converger test without it — that is how P11 was nearly closed on a false
# pass), and that dependency must survive.

export RESEND_API_KEY=''
export MAIL_FROM=''
export SMTP_HOST=''
export SMTP_PORT=''
export SMTP_USER=''
export SMTP_PASS=''
export GMAIL_SA_KEY_FILE=''
export GMAIL_SA_CLIENT_EMAIL=''
export GMAIL_SA_PRIVATE_KEY=''
export GMAIL_SEND_AS=''

# PROVE IT — do not assume it. A list of exports is a claim; this is the check.
#
# The probe is spawned exactly the way the gate spawns its children
# (`node --env-file-if-exists=.env`), so it sees precisely what a gate step sees,
# .env and all. If the mailer is live in that environment the gate REFUSES TO RUN,
# rather than running and hoping no step reaches a send. Refusing to certify is
# always available; certifying without checking is not.
if ! _nomail_out=$(node --env-file-if-exists=.env \
      -e "import('./src/utils/mailer.js').then(m => { if (m.mailerConfigured()) { console.error('MAILER-IS-LIVE'); process.exit(1); } }, e => { console.error('mailer probe failed to load: ' + e.message); process.exit(1); })" 2>&1); then
  echo "" >&2
  echo "GATE REFUSED TO RUN: real email could be sent from this gate run." >&2
  echo "  A gate step (scripts/checks/approval-adversarial.mjs) reaches the real" >&2
  echo "  mailer, so a live mail credential here means the checkpoint emails real" >&2
  echo "  people — silently, and it still reports PASS." >&2
  echo "  scripts/gates/_no-mail.sh blanks the mail credentials for every child of" >&2
  echo "  the gate; something is putting one back. Do not delete this check to get" >&2
  echo "  a green run." >&2
  echo "  probe output: ${_nomail_out}" >&2
  exit 1
fi
unset _nomail_out
