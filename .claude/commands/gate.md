---
description: Close a phase gate. Spawns the fresh Verifier subagent to confirm the phase's "Done when" is really met, fail-closed.
argument-hint: <phase 0-7>
allowed-tools: Bash, Read, Grep, Glob, Task
model: opus
---

Close the gate for **Phase $1** of the Atlas build.

You are the orchestrator here, not the checker. Do the following:

1. Confirm `$1` is a phase number 0–7. If missing or invalid, stop and ask.
2. Do **not** verify it yourself and do **not** edit any code — you may have
   written this code, and a gate is only valid when closed by an independent
   agent. Spawn the **verifier** subagent (Task tool) with instructions to
   verify Phase $1: run `bash scripts/gate.sh $1`, review the artifacts against
   the "Done when" in `docs/agntic-ops-gap-and-build-plan.md`, and report a
   fail-closed verdict with evidence.
3. Relay the Verifier's verdict verbatim.
   - If **FAIL**: do not advance. Summarize exactly what's missing and stop. The
     phase stays open; the `pre-push` hook will also refuse the gate commit until
     `scripts/gates/p$1.sh` passes.
   - If **PASS**: confirm the Verifier wrote `docs/gates/p$1.md`, then tick
     Phase $1 in the `CLAUDE.md` checklist and tell me the exact gate-closing
     commit to make — a `feat`/`fix` with `Phase: $1`, a `Gate:` trailer quoting
     the Done-when, and `Verified-by: verifier`.

Never use `--no-verify`. Never weaken `scripts/gates/*.sh` to force a pass.
