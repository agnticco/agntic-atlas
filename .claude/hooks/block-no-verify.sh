#!/usr/bin/env bash
# Claude Code PreToolUse(Bash) hook. Blocks any Bash command containing
# --no-verify so an agent cannot silently skip the commit-msg / pre-push hard
# gates. Exit 2 tells Claude Code to deny the tool call and surface the reason.
input="$(cat)"
case "$input" in
  *--no-verify*)
    echo "Blocked: --no-verify bypasses Atlas's hard gate (commit-msg and pre-push)." >&2
    echo "Fix the work or the gate check instead of skipping verification." >&2
    exit 2
    ;;
esac
exit 0
